import { createHash } from "node:crypto";
import {
  derivePublicRoomStatus,
  type Message,
  type RoomStatus,
  type Sender,
  type StoredCloseReason,
  type StoredRoom,
} from "@agentmeets/shared";
import { createPgPool, type PgQueryable, type PgTransactionClient, withPgTransaction } from "./pg.js";
import {
  InviteError,
  type AgentMeetsStore,
  type CreateRoomWithInvitesInput,
  type CreateRoomInput,
  type InviteClaimResult,
  type InviteManifest,
  type PublicRoomSnapshot,
  type RoomTokenLookup,
  type StoredInvite,
} from "./store.js";
import type { Pool } from "pg";

const DEFAULT_INVITE_TTL_MS = 5 * 60 * 1000;

type RoomRow = Omit<StoredRoom, "opening_message_id"> & {
  opening_message_id?: string | number | null;
};

type MessageRow = Omit<Message, "id"> & { id: string | number };
type InviteRow = Omit<StoredInvite, "id"> & { id: string | number };
type PublicRoomSnapshotRow = {
  room_id: string;
  room_stem: string;
  room_status: StoredRoom["status"];
  host_connected_at: string | null;
  guest_connected_at: string | null;
  invite_expires_at: string | null;
};

export function createPostgresAgentMeetsStore(options: {
  pool?: Pool;
  connectionString?: string;
} = {}): AgentMeetsStore {
  const pool = options.pool ?? createPgPool(options.connectionString);
  return new PostgresAgentMeetsStore(pool);
}

class PostgresAgentMeetsStore implements AgentMeetsStore {
  constructor(private readonly pool: Pool) {}

  async createRoom(input: CreateRoomInput): Promise<StoredRoom> {
    return withPgTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO am_rooms (id, room_stem, host_token, status)
         VALUES ($1, $2, $3, 'waiting')`,
        [input.id, input.roomStem ?? null, input.hostToken],
      );

      if (input.openingMessage) {
        const message = await queryRequiredRow<MessageRow>(
          client,
          `INSERT INTO am_messages (room_id, sender, content)
           VALUES ($1, 'host', $2)
           RETURNING *`,
          [input.id, input.openingMessage],
        );

        await client.query(
          `UPDATE am_rooms
           SET opening_message_id = $1
           WHERE id = $2`,
          [message.id, input.id],
        );
      }

      return this.getRequiredRoom(client, input.id);
    });
  }

  async createRoomWithInvites(input: CreateRoomWithInvitesInput): Promise<void> {
    await withPgTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO am_rooms (id, room_stem, host_token, status)
         VALUES ($1, $2, $3, 'waiting')`,
        [input.roomId, input.roomStem, input.hostToken],
      );

      const openingMessage = await queryRequiredRow<MessageRow>(
        client,
        `INSERT INTO am_messages (room_id, sender, content)
         VALUES ($1, 'host', $2)
         RETURNING *`,
        [input.roomId, input.openingMessage],
      );

      await client.query(
        `UPDATE am_rooms
         SET opening_message_id = $1
         WHERE id = $2`,
        [openingMessage.id, input.roomId],
      );

      await client.query(
        `INSERT INTO am_invites (room_id, participant_role, token_hash, expires_at)
         VALUES
           ($1, 'host', $2, $4),
           ($1, 'guest', $3, $4)`,
        [
          input.roomId,
          hashInviteToken(`${input.roomStem}.1`),
          hashInviteToken(`${input.roomStem}.2`),
          input.inviteExpiresAt,
        ],
      );
    });
  }

  async getRoom(id: string): Promise<StoredRoom | null> {
    const row = await queryOptionalRow<RoomRow>(
      this.pool,
      `SELECT *
       FROM am_rooms
       WHERE id = $1`,
      [id],
    );
    return row ? mapRoom(row) : null;
  }

  async getPublicRoomSnapshot(roomStem: string): Promise<PublicRoomSnapshot | null> {
    const row = await queryOptionalRow<PublicRoomSnapshotRow>(
      this.pool,
      `SELECT
         r.id AS room_id,
         r.room_stem,
         r.status AS room_status,
         r.host_connected_at,
         r.guest_connected_at,
         MIN(i.expires_at) AS invite_expires_at
       FROM am_rooms r
       LEFT JOIN am_invites i ON i.room_id = r.id
       WHERE r.room_stem = $1
       GROUP BY r.id, r.room_stem, r.status, r.host_connected_at, r.guest_connected_at`,
      [roomStem],
    );

    if (!row) {
      return null;
    }

    return {
      roomId: row.room_id,
      roomStem: row.room_stem,
      roomStatus: row.room_status,
      hostConnectedAt: row.host_connected_at,
      guestConnectedAt: row.guest_connected_at,
      inviteExpiresAt: row.invite_expires_at,
    };
  }

  async joinRoom(id: string, guestToken: string): Promise<StoredRoom> {
    const row = await queryOptionalRow<RoomRow>(
      this.pool,
      `UPDATE am_rooms
       SET guest_token = $1,
           status = 'active',
           host_connected_at = COALESCE(host_connected_at, now()),
           guest_connected_at = now(),
           joined_at = now(),
           last_activity_at = now()
       WHERE id = $2
         AND guest_token IS NULL
         AND status = 'waiting'
       RETURNING *`,
      [guestToken, id],
    );
    if (row) {
      return mapRoom(row);
    }

    const room = await this.getRoom(id);
    if (!room) {
      throw new Error("Room not found");
    }
    if (room.status === "expired" || room.status === "closed") {
      throw new Error(`Room is ${room.status}`);
    }
    if (room.guest_token !== null) {
      throw new Error("Room is full");
    }

    throw new Error("Room join conflict");
  }

  async activateRoom(id: string): Promise<StoredRoom> {
    const room = await this.getRoom(id);
    if (!room) {
      throw new Error("Room not found");
    }
    if (room.status === "expired" || room.status === "closed") {
      throw new Error(`Room is ${room.status}`);
    }
    if (room.status === "active") {
      return room;
    }
    if (room.guest_token === null) {
      throw new Error("Room has no guest");
    }

    const row = await queryRequiredRow<RoomRow>(
      this.pool,
      `UPDATE am_rooms
       SET status = 'active',
           host_connected_at = COALESCE(host_connected_at, now()),
           guest_connected_at = COALESCE(guest_connected_at, now()),
           joined_at = COALESCE(joined_at, now())
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    return mapRoom(row);
  }

  async closeRoom(id: string, reason: StoredCloseReason): Promise<void> {
    await this.pool.query(
      `UPDATE am_rooms
       SET status = 'closed',
           closed_at = now(),
           close_reason = $1,
           host_connected_at = NULL,
           guest_connected_at = NULL
       WHERE id = $2`,
      [reason, id],
    );
  }

  async expireRoom(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE am_rooms
       SET status = 'expired',
           closed_at = now(),
           host_connected_at = NULL,
           guest_connected_at = NULL
       WHERE id = $1`,
      [id],
    );
  }

  async markRoleConnected(roomId: string, role: Sender): Promise<void> {
    const column = role === "host" ? "host_connected_at" : "guest_connected_at";
    await this.pool.query(
      `UPDATE am_rooms
       SET ${column} = now()
       WHERE id = $1`,
      [roomId],
    );
  }

  async clearRoleConnected(roomId: string, role: Sender): Promise<void> {
    const column = role === "host" ? "host_connected_at" : "guest_connected_at";
    await this.pool.query(
      `UPDATE am_rooms
       SET ${column} = NULL
       WHERE id = $1`,
      [roomId],
    );
  }

  async touchRoomActivity(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE am_rooms
       SET last_activity_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  async getRoomByToken(token: string): Promise<RoomTokenLookup | null> {
    const row = await queryOptionalRow<RoomRow>(
      this.pool,
      `SELECT *
       FROM am_rooms
       WHERE host_token = $1 OR guest_token = $1
       LIMIT 1`,
      [token],
    );
    if (!row) {
      return null;
    }
    const room = mapRoom(row);
    return {
      room,
      role: room.host_token === token ? "host" : "guest",
    };
  }

  async saveMessage(roomId: string, sender: Sender, content: string): Promise<Message> {
    return withPgTransaction(this.pool, async (client) => {
      const message = await queryRequiredRow<MessageRow>(
        client,
        `INSERT INTO am_messages (room_id, sender, content)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [roomId, sender, content],
      );

      await client.query(
        `UPDATE am_rooms
         SET last_activity_at = now()
         WHERE id = $1`,
        [roomId],
      );

      return mapMessage(message);
    });
  }

  async getMessages(roomId: string): Promise<Message[]> {
    const rows = await queryRows<MessageRow>(
      this.pool,
      `SELECT *
       FROM am_messages
       WHERE room_id = $1
       ORDER BY created_at ASC, id ASC`,
      [roomId],
    );
    return rows.map(mapMessage);
  }

  async getPendingMessages(roomId: string): Promise<Message[]> {
    const rows = await queryRows<MessageRow>(
      this.pool,
      `SELECT m.*
       FROM am_messages m
       JOIN am_rooms r ON r.id = m.room_id
       WHERE m.room_id = $1
         AND m.sender = 'host'
         AND (r.joined_at IS NULL OR m.created_at < r.joined_at)
       ORDER BY m.created_at ASC, m.id ASC`,
      [roomId],
    );
    return rows.map(mapMessage);
  }

  async getReplayMessages(roomId: string, role: Sender): Promise<Message[]> {
    const messages = await this.getMessages(roomId);
    if (role === "guest") {
      return messages.filter((message) => message.sender === "host");
    }
    return messages.filter((message) => message.sender === "guest");
  }

  async getOpeningMessage(roomId: string): Promise<Message | null> {
    const row = await queryOptionalRow<MessageRow>(
      this.pool,
      `SELECT m.*
       FROM am_rooms r
       JOIN am_messages m ON m.id = r.opening_message_id
       WHERE r.id = $1`,
      [roomId],
    );
    return row ? mapMessage(row) : null;
  }

  async createInvite(roomId: string, inviteToken: string, expiresAt?: string): Promise<{ expiresAt: string }> {
    const resolvedExpiresAt = expiresAt ?? new Date(Date.now() + DEFAULT_INVITE_TTL_MS).toISOString();
    await this.pool.query(
      `INSERT INTO am_invites (room_id, participant_role, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [roomId, deriveParticipantRoleFromToken(inviteToken), hashInviteToken(inviteToken), resolvedExpiresAt],
    );
    return { expiresAt: resolvedExpiresAt };
  }

  async issueInvite(roomId: string, inviteToken: string, expiresAt?: string): Promise<{ expiresAt: string }> {
    return this.createInvite(roomId, inviteToken, expiresAt);
  }

  async getInviteManifest(inviteToken: string): Promise<InviteManifest> {
    const record = await this.getInviteLookup(inviteToken);
    if (!record) {
      throw new InviteError("Invite not found", 404, "invite_not_found");
    }

    await this.ensureInviteUsable(record);

    return {
      roomId: record.room_id,
      status: deriveInviteStatus(record.room_status, record.host_connected_at, record.guest_connected_at),
      openingMessage: record.opening_message ?? "",
      expiresAt: record.expires_at,
    };
  }

  async claimInvite(inviteToken: string, idempotencyKey: string): Promise<InviteClaimResult> {
    return withPgTransaction(this.pool, async (client) => {
      const record = await this.getInviteLookup(inviteToken, client, true);
      if (!record) {
        throw new InviteError("Invite not found", 404, "invite_not_found");
      }

      if (record.claimed_at !== null) {
        if (record.claim_idempotency_key === idempotencyKey) {
          const sessionToken = record.claim_session_token
            ?? (record.participant_role === "host"
              ? record.host_token
              : record.claim_guest_token ?? record.guest_token);
          if (!sessionToken) {
            throw new InviteError("Invite claim state is invalid", 500, "invite_claim_invalid");
          }
          return {
            roomId: record.room_id,
            role: record.participant_role,
            sessionToken,
            ...(record.participant_role === "guest" ? { guestToken: sessionToken } : {}),
            status: deriveInviteStatus(record.room_status, record.host_connected_at, record.guest_connected_at),
          };
        }

        throw new InviteError("Invite has already been claimed", 409, "invite_already_claimed");
      }

      await this.ensureInviteUsable(record, client);

      if (record.participant_role === "guest" && record.guest_token !== null) {
        throw new InviteError("Invite has already been claimed", 409, "invite_already_claimed");
      }

      const sessionToken = record.participant_role === "host"
        ? record.host_token
        : (record.guest_token ?? crypto.randomUUID());

      if (record.participant_role === "guest") {
        await client.query(
          `UPDATE am_rooms
           SET guest_token = $1
           WHERE id = $2`,
          [sessionToken, record.room_id],
        );
      }

      await client.query(
        `UPDATE am_invites
         SET claimed_at = now(),
             claim_idempotency_key = $1,
             claim_session_token = $2,
             claim_guest_token = $3
         WHERE token_hash = $4`,
        [
          idempotencyKey,
          sessionToken,
          record.participant_role === "guest" ? sessionToken : null,
          hashInviteToken(inviteToken),
        ],
      );

      await client.query(
        `UPDATE am_rooms
         SET last_activity_at = now()
         WHERE id = $1`,
        [record.room_id],
      );

      const refreshed = await this.getInviteLookup(inviteToken, client, false);
      if (!refreshed) {
        throw new InviteError("Invite not found", 404, "invite_not_found");
      }

      return {
        roomId: refreshed.room_id,
        role: refreshed.participant_role,
        sessionToken,
        ...(refreshed.participant_role === "guest" ? { guestToken: sessionToken } : {}),
        status: deriveInviteStatus(refreshed.room_status, refreshed.host_connected_at, refreshed.guest_connected_at),
      };
    });
  }

  async sweepExpiredRooms(now: Date = new Date()): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM am_rooms
       WHERE status IN ('closed', 'expired')
         AND created_at < $1`,
      [new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()],
    );
    return result.rowCount ?? 0;
  }

  private async getRequiredRoom(queryable: PgQueryable, roomId: string): Promise<StoredRoom> {
    const row = await queryRequiredRow<RoomRow>(
      queryable,
      `SELECT *
       FROM am_rooms
       WHERE id = $1`,
      [roomId],
    );
    return mapRoom(row);
  }

  private async getInviteLookup(
    inviteToken: string,
    queryable: PgQueryable = this.pool,
    forUpdate = false,
  ): Promise<(InviteRow & {
    room_status: StoredRoom["status"];
    room_stem: string | null;
    host_token: string;
    guest_token: string | null;
    host_connected_at: string | null;
    guest_connected_at: string | null;
    joined_at: string | null;
    opening_message: string | null;
  }) | null> {
    const lockClause = forUpdate ? " FOR UPDATE OF i, r" : "";
    return queryOptionalRow(
      queryable,
      `SELECT
         i.*,
         r.room_stem,
         r.status AS room_status,
         r.host_token,
         r.guest_token,
         r.host_connected_at,
         r.guest_connected_at,
         r.joined_at,
         COALESCE(
           opening_message.content,
           (
             SELECT fallback.content
             FROM am_messages fallback
             WHERE fallback.room_id = r.id
               AND fallback.sender = 'host'
             ORDER BY fallback.id ASC
             LIMIT 1
           )
         ) AS opening_message
       FROM am_invites i
       JOIN am_rooms r ON r.id = i.room_id
       LEFT JOIN am_messages opening_message ON opening_message.id = r.opening_message_id
       WHERE i.token_hash = $1${lockClause}`,
      [hashInviteToken(inviteToken)],
    );
  }

  private async ensureInviteUsable(
    record: {
      room_id: string;
      room_status: StoredRoom["status"];
      expires_at: string;
    },
    queryable: PgQueryable = this.pool,
  ): Promise<void> {
    if (record.room_status === "active") {
      return;
    }
    if (record.room_status === "closed" || record.room_status === "expired") {
      throw new InviteError("Invite has expired", 410, "invite_expired");
    }
    if (new Date(record.expires_at).getTime() <= Date.now()) {
      await queryable.query(
        `UPDATE am_rooms
         SET status = 'expired',
             closed_at = now(),
             host_connected_at = NULL,
             guest_connected_at = NULL
         WHERE id = $1
           AND status = 'waiting'`,
        [record.room_id],
      );
      throw new InviteError("Invite has expired", 410, "invite_expired");
    }
  }
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function deriveParticipantRoleFromToken(token: string): Sender {
  return token.endsWith(".1") ? "host" : "guest";
}

function mapRoom(row: RoomRow): StoredRoom {
  return {
    ...row,
    opening_message_id: row.opening_message_id == null ? null : Number(row.opening_message_id),
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    ...row,
    id: Number(row.id),
  };
}

function deriveInviteStatus(
  roomStatus: StoredRoom["status"],
  hostConnectedAt: string | null,
  guestConnectedAt: string | null,
): RoomStatus {
  return derivePublicRoomStatus({
    roomStatus,
    hostConnectedAt,
    guestConnectedAt,
  });
}

async function queryRequiredRow<R extends object>(
  queryable: PgQueryable,
  text: string,
  params: readonly unknown[],
): Promise<R> {
  const result = await queryable.query<R>(text, params);
  if (result.rowCount !== 1) {
    throw new Error("expected one row");
  }
  return result.rows[0];
}

async function queryOptionalRow<R extends object>(
  queryable: PgQueryable,
  text: string,
  params: readonly unknown[],
): Promise<R | null> {
  const result = await queryable.query<R>(text, params);
  return result.rowCount ? result.rows[0] : null;
}

async function queryRows<R extends object>(
  queryable: PgQueryable,
  text: string,
  params: readonly unknown[],
): Promise<R[]> {
  const result = await queryable.query<R>(text, params);
  return result.rows;
}
