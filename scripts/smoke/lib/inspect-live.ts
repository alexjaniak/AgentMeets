import { Database } from "bun:sqlite";

const ROOM_STEM_PATTERN = /^r_[A-Za-z0-9_-]+$/;
const INVITE_TOKEN_PATTERN = /^(r_[A-Za-z0-9_-]+)\.[12]$/;
const DEFAULT_ROOM_LIMIT = 3;

interface RoomRow {
  room_id: string;
  room_stem: string | null;
  status: string;
  created_at: string;
  last_activity_at: string;
  joined_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  opening_message: string | null;
}

interface InviteRow {
  participant_role: "host" | "guest";
  expires_at: string;
  claimed_at: string | null;
  has_session_token: number;
}

interface MessageRow {
  id: number;
  sender: "host" | "guest";
  content: string;
  created_at: string;
}

export interface LiveSmokeInvite {
  participantRole: "host" | "guest";
  expiresAt: string;
  claimedAt: string | null;
  hasSessionToken: boolean;
}

export interface LiveSmokeMessage {
  id: number;
  sender: "host" | "guest";
  content: string;
  createdAt: string;
}

export interface LiveSmokeRoom {
  roomId: string;
  roomStem: string | null;
  status: string;
  createdAt: string;
  lastActivityAt: string;
  joinedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  openingMessage: string | null;
  invites: LiveSmokeInvite[];
  messages: LiveSmokeMessage[];
}

export interface LiveSmokeSnapshot {
  dbPath: string;
  rooms: LiveSmokeRoom[];
}

export interface ReadLiveSmokeSnapshotOptions {
  dbPath: string;
  roomId?: string;
  roomStemOrInvite?: string;
  limit?: number;
}

export function resolveRoomStemFilter(roomStemOrInvite: string): string {
  const normalized = roomStemOrInvite.trim();
  if (ROOM_STEM_PATTERN.test(normalized)) {
    return normalized;
  }

  const candidate = extractInviteTokenCandidate(normalized);
  const inviteMatch = candidate.match(INVITE_TOKEN_PATTERN);
  if (inviteMatch) {
    return inviteMatch[1];
  }

  throw new Error(`Could not derive room stem from "${roomStemOrInvite}"`);
}

export function readLiveSmokeSnapshot(
  options: ReadLiveSmokeSnapshotOptions,
): LiveSmokeSnapshot {
  const roomStem = options.roomStemOrInvite
    ? resolveRoomStemFilter(options.roomStemOrInvite)
    : undefined;
  const roomLimit = options.limit ?? DEFAULT_ROOM_LIMIT;
  const db = new Database(options.dbPath);

  try {
    const rooms = readRooms(db, {
      roomId: options.roomId,
      roomStem,
      limit: roomLimit,
    });

    return {
      dbPath: options.dbPath,
      rooms: rooms.map((room) => ({
        roomId: room.room_id,
        roomStem: room.room_stem,
        status: room.status,
        createdAt: room.created_at,
        lastActivityAt: room.last_activity_at,
        joinedAt: room.joined_at,
        closedAt: room.closed_at,
        closeReason: room.close_reason,
        openingMessage: room.opening_message,
        invites: readInvites(db, room.room_id),
        messages: readMessages(db, room.room_id),
      })),
    };
  } finally {
    db.close();
  }
}

export function formatLiveSmokeSnapshot(snapshot: LiveSmokeSnapshot): string {
  const lines = [`DB: ${snapshot.dbPath}`];
  if (snapshot.rooms.length === 0) {
    lines.push("No rooms found.");
    return lines.join("\n");
  }

  snapshot.rooms.forEach((room, index) => {
    if (index > 0) {
      lines.push("");
    }

    lines.push(`Room ${room.roomId} (${room.roomStem ?? "no room stem"})`);
    lines.push(`status: ${room.status}`);
    lines.push(`createdAt: ${room.createdAt}`);
    lines.push(`lastActivityAt: ${room.lastActivityAt}`);
    if (room.joinedAt) {
      lines.push(`joinedAt: ${room.joinedAt}`);
    }
    if (room.closedAt) {
      lines.push(`closedAt: ${room.closedAt}`);
    }
    if (room.closeReason) {
      lines.push(`closeReason: ${room.closeReason}`);
    }
    if (room.openingMessage) {
      lines.push(`openingMessage: ${room.openingMessage}`);
    }

    lines.push("invites:");
    if (room.invites.length === 0) {
      lines.push("- none");
    } else {
      room.invites.forEach((invite) => {
        lines.push(
          `- ${invite.participantRole} | claimed=${invite.claimedAt ? "yes" : "no"} | sessionToken=${invite.hasSessionToken ? "yes" : "no"} | expiresAt=${invite.expiresAt}`,
        );
      });
    }

    lines.push("messages:");
    if (room.messages.length === 0) {
      lines.push("- none");
    } else {
      room.messages.forEach((message, messageIndex) => {
        lines.push(
          `${messageIndex + 1}. [${message.sender}] ${message.createdAt} ${message.content}`,
        );
      });
    }
  });

  return lines.join("\n");
}

function extractInviteTokenCandidate(input: string): string {
  if (input.includes("://")) {
    const url = new URL(input);
    return url.pathname.split("/").pop() ?? "";
  }

  return input.split("/").pop() ?? "";
}

function readRooms(
  db: Database,
  options: {
    roomId?: string;
    roomStem?: string;
    limit: number;
  },
): RoomRow[] {
  const filters: string[] = [];
  const params: Array<string | number> = [];

  if (options.roomId) {
    filters.push("r.id = ?");
    params.push(options.roomId);
  }

  if (options.roomStem) {
    filters.push("r.room_stem = ?");
    params.push(options.roomStem);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const limitClause = filters.length > 0 ? "" : "LIMIT ?";

  if (limitClause) {
    params.push(options.limit);
  }

  return db
    .prepare(
      `SELECT
         r.id AS room_id,
         r.room_stem,
         r.status,
         r.created_at,
         r.last_activity_at,
         r.joined_at,
         r.closed_at,
         r.close_reason,
         opening_message.content AS opening_message
       FROM rooms r
       LEFT JOIN messages opening_message ON opening_message.id = r.opening_message_id
       ${whereClause}
       ORDER BY COALESCE(r.last_activity_at, r.created_at) DESC, r.id DESC
       ${limitClause}`,
    )
    .all(...params) as RoomRow[];
}

function readInvites(db: Database, roomId: string): LiveSmokeInvite[] {
  const rows = db
    .prepare(
      `SELECT
         participant_role,
         expires_at,
         claimed_at,
         CASE WHEN claim_session_token IS NOT NULL THEN 1 ELSE 0 END AS has_session_token
       FROM invites
       WHERE room_id = ?
       ORDER BY CASE participant_role WHEN 'guest' THEN 0 WHEN 'host' THEN 1 ELSE 2 END ASC`,
    )
    .all(roomId) as InviteRow[];

  return rows.map((row) => ({
    participantRole: row.participant_role,
    expiresAt: row.expires_at,
    claimedAt: row.claimed_at,
    hasSessionToken: row.has_session_token === 1,
  }));
}

function readMessages(db: Database, roomId: string): LiveSmokeMessage[] {
  const rows = db
    .prepare(
      `SELECT id, sender, content, created_at
       FROM messages
       WHERE room_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(roomId) as MessageRow[];

  return rows.map((row) => ({
    id: row.id,
    sender: row.sender,
    content: row.content,
    createdAt: row.created_at,
  }));
}
