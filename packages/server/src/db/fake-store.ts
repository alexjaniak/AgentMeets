import { createHash } from "node:crypto";
import {
  derivePublicRoomStatus,
  type Message,
  type RoomStatus,
  type Sender,
  type StoredCloseReason,
  type StoredRoom,
} from "@agentmeets/shared";
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

const DEFAULT_INVITE_TTL_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type MutableMessage = Message;
type MutableRoom = StoredRoom;

export function createFakeAgentMeetsStore(): AgentMeetsStore {
  const rooms = new Map<string, MutableRoom>();
  const messages = new Map<string, MutableMessage[]>();
  const invites = new Map<string, StoredInvite>();

  let nextMessageId = 1;
  let nextInviteId = 1;

  const getRoomMessages = (roomId: string): MutableMessage[] => {
    const roomMessages = messages.get(roomId);
    if (roomMessages) {
      return roomMessages;
    }
    const created: MutableMessage[] = [];
    messages.set(roomId, created);
    return created;
  };

  const sortMessages = (roomMessages: MutableMessage[]): MutableMessage[] =>
    [...roomMessages].sort((left, right) => {
      if (left.created_at === right.created_at) {
        return left.id - right.id;
      }
      return left.created_at.localeCompare(right.created_at);
    });

  const getRoomOrThrow = (roomId: string): MutableRoom => {
    const room = rooms.get(roomId);
    if (!room) {
      throw new Error("Room not found");
    }
    return room;
  };

  const cloneRoom = (room: MutableRoom): StoredRoom => ({ ...room });
  const cloneMessage = (message: MutableMessage): Message => ({ ...message });

  const deriveParticipantRoleFromToken = (token: string): Sender =>
    token.endsWith(".1") ? "host" : "guest";

  const hashInviteToken = (token: string): string =>
    createHash("sha256").update(token).digest("hex");

  const currentTimestamp = (): string => new Date().toISOString();

  const getOpeningMessageForRoom = (room: MutableRoom): Message | null => {
    const roomMessages = sortMessages(getRoomMessages(room.id));
    if (typeof room.opening_message_id === "number") {
      return roomMessages.find((message) => message.id === room.opening_message_id) ?? null;
    }
    return roomMessages.find((message) => message.sender === "host") ?? null;
  };

  const deriveInviteStatus = (room: MutableRoom): RoomStatus =>
    derivePublicRoomStatus({
      roomStatus: room.status,
      hostConnectedAt: room.host_connected_at,
      guestConnectedAt: room.guest_connected_at,
    });

  const ensureInviteUsable = async (invite: StoredInvite): Promise<MutableRoom> => {
    const room = getRoomOrThrow(invite.room_id);
    if (room.status === "active") {
      return room;
    }
    if (room.status === "closed" || room.status === "expired") {
      throw new InviteError("Invite has expired", 410, "invite_expired");
    }
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      await api.expireRoom(room.id);
      throw new InviteError("Invite has expired", 410, "invite_expired");
    }
    return room;
  };

  const api: AgentMeetsStore = {
    async createRoom(input: CreateRoomInput): Promise<StoredRoom> {
      if (rooms.has(input.id)) {
        throw new Error("duplicate room id");
      }
      if (input.roomStem && [...rooms.values()].some((room) => room.room_stem === input.roomStem)) {
        throw new Error("duplicate room stem");
      }

      const createdAt = currentTimestamp();
      const room: MutableRoom = {
        id: input.id,
        room_stem: input.roomStem ?? null,
        host_token: input.hostToken,
        guest_token: null,
        status: "waiting",
        opening_message_id: null,
        host_connected_at: null,
        guest_connected_at: null,
        created_at: createdAt,
        last_activity_at: createdAt,
        joined_at: null,
        closed_at: null,
        close_reason: null,
      };
      rooms.set(room.id, room);
      messages.set(room.id, []);

      if (input.openingMessage) {
        const openingMessage = await api.saveMessage(room.id, "host", input.openingMessage);
        room.opening_message_id = openingMessage.id;
      }

      return cloneRoom(room);
    },

    async createRoomWithInvites(input: CreateRoomWithInvitesInput): Promise<void> {
      const existingRoom = rooms.get(input.roomId);
      const existingMessages = messages.get(input.roomId);
      const existingInvites = [...invites.entries()]
        .filter(([, invite]) => invite.room_id === input.roomId);

      try {
        await api.createRoom({
          id: input.roomId,
          roomStem: input.roomStem,
          hostToken: input.hostToken,
          openingMessage: input.openingMessage,
        });
        await api.issueInvite(input.roomId, `${input.roomStem}.1`, input.inviteExpiresAt);
        await api.issueInvite(input.roomId, `${input.roomStem}.2`, input.inviteExpiresAt);
      } catch (error) {
        if (existingRoom) {
          rooms.set(input.roomId, existingRoom);
        } else {
          rooms.delete(input.roomId);
        }

        if (existingMessages) {
          messages.set(input.roomId, existingMessages);
        } else {
          messages.delete(input.roomId);
        }

        for (const [tokenHash, invite] of [...invites.entries()]) {
          if (invite.room_id === input.roomId) {
            invites.delete(tokenHash);
          }
        }
        for (const [tokenHash, invite] of existingInvites) {
          invites.set(tokenHash, invite);
        }

        throw error;
      }
    },

    async getRoom(id: string): Promise<StoredRoom | null> {
      const room = rooms.get(id);
      return room ? cloneRoom(room) : null;
    },

    async getPublicRoomSnapshot(roomStem: string): Promise<PublicRoomSnapshot | null> {
      const room = [...rooms.values()].find((candidate) => candidate.room_stem === roomStem);
      if (!room || !room.room_stem) {
        return null;
      }

      const roomInvites = [...invites.values()]
        .filter((invite) => invite.room_id === room.id)
        .sort((left, right) => left.expires_at.localeCompare(right.expires_at));

      return {
        roomId: room.id,
        roomStem: room.room_stem,
        roomStatus: room.status,
        hostConnectedAt: room.host_connected_at,
        guestConnectedAt: room.guest_connected_at,
        inviteExpiresAt: roomInvites[0]?.expires_at ?? null,
      };
    },

    async joinRoom(id: string, guestToken: string): Promise<StoredRoom> {
      const room = getRoomOrThrow(id);
      if (room.status === "expired" || room.status === "closed") {
        throw new Error(`Room is ${room.status}`);
      }
      if (room.guest_token !== null) {
        throw new Error("Room is full");
      }

      const now = currentTimestamp();
      room.guest_token = guestToken;
      room.status = "active";
      room.host_connected_at = room.host_connected_at ?? now;
      room.guest_connected_at = now;
      room.joined_at = now;
      room.last_activity_at = now;
      return cloneRoom(room);
    },

    async activateRoom(id: string): Promise<StoredRoom> {
      const room = getRoomOrThrow(id);
      if (room.status === "expired" || room.status === "closed") {
        throw new Error(`Room is ${room.status}`);
      }
      if (room.status === "active") {
        return cloneRoom(room);
      }
      if (room.guest_token === null) {
        throw new Error("Room has no guest");
      }

      const now = currentTimestamp();
      room.status = "active";
      room.host_connected_at = room.host_connected_at ?? now;
      room.guest_connected_at = room.guest_connected_at ?? now;
      room.joined_at = room.joined_at ?? now;
      return cloneRoom(room);
    },

    async closeRoom(id: string, reason: StoredCloseReason): Promise<void> {
      const room = getRoomOrThrow(id);
      room.status = "closed";
      room.closed_at = currentTimestamp();
      room.close_reason = reason;
      room.host_connected_at = null;
      room.guest_connected_at = null;
    },

    async expireRoom(id: string): Promise<void> {
      const room = getRoomOrThrow(id);
      room.status = "expired";
      room.closed_at = currentTimestamp();
      room.host_connected_at = null;
      room.guest_connected_at = null;
    },

    async markRoleConnected(roomId: string, role: Sender): Promise<void> {
      const room = getRoomOrThrow(roomId);
      const now = currentTimestamp();
      if (role === "host") {
        room.host_connected_at = now;
      } else {
        room.guest_connected_at = now;
      }
    },

    async clearRoleConnected(roomId: string, role: Sender): Promise<void> {
      const room = getRoomOrThrow(roomId);
      if (role === "host") {
        room.host_connected_at = null;
      } else {
        room.guest_connected_at = null;
      }
    },

    async touchRoomActivity(id: string): Promise<void> {
      const room = getRoomOrThrow(id);
      room.last_activity_at = currentTimestamp();
    },

    async getRoomByToken(token: string): Promise<RoomTokenLookup | null> {
      for (const room of rooms.values()) {
        if (room.host_token === token) {
          return { room: cloneRoom(room), role: "host" };
        }
        if (room.guest_token === token) {
          return { room: cloneRoom(room), role: "guest" };
        }
      }
      return null;
    },

    async saveMessage(roomId: string, sender: Sender, content: string): Promise<Message> {
      getRoomOrThrow(roomId);
      const message: MutableMessage = {
        id: nextMessageId,
        room_id: roomId,
        sender,
        content,
        created_at: currentTimestamp(),
      };
      nextMessageId += 1;
      getRoomMessages(roomId).push(message);
      await api.touchRoomActivity(roomId);
      return cloneMessage(message);
    },

    async getMessages(roomId: string): Promise<Message[]> {
      return sortMessages(getRoomMessages(roomId)).map(cloneMessage);
    },

    async getPendingMessages(roomId: string): Promise<Message[]> {
      const room = getRoomOrThrow(roomId);
      return sortMessages(getRoomMessages(roomId))
        .filter((message) =>
          message.sender === "host"
          && (room.joined_at === null || message.created_at < room.joined_at))
        .map(cloneMessage);
    },

    async getReplayMessages(roomId: string, role: Sender): Promise<Message[]> {
      const roomMessages = await api.getMessages(roomId);
      if (role === "guest") {
        return roomMessages.filter((message) => message.sender === "host");
      }
      return roomMessages.filter((message) => message.sender === "guest");
    },

    async getOpeningMessage(roomId: string): Promise<Message | null> {
      const room = getRoomOrThrow(roomId);
      const message = getOpeningMessageForRoom(room);
      return message ? cloneMessage(message) : null;
    },

    async createInvite(roomId: string, inviteToken: string, expiresAt?: string): Promise<{ expiresAt: string }> {
      getRoomOrThrow(roomId);
      const tokenHash = hashInviteToken(inviteToken);
      if (invites.has(tokenHash)) {
        throw new Error("duplicate invite token");
      }

      const participantRole = deriveParticipantRoleFromToken(inviteToken);
      const roomInvites = [...invites.values()].filter((invite) => invite.room_id === roomId);
      if (roomInvites.some((invite) => invite.participant_role === participantRole)) {
        throw new Error("duplicate invite role");
      }

      const resolvedExpiresAt = expiresAt ?? new Date(Date.now() + DEFAULT_INVITE_TTL_MS).toISOString();
      invites.set(tokenHash, {
        id: nextInviteId,
        room_id: roomId,
        participant_role: participantRole,
        token_hash: tokenHash,
        expires_at: resolvedExpiresAt,
        claimed_at: null,
        claim_idempotency_key: null,
        claim_session_token: null,
        claim_guest_token: null,
        created_at: currentTimestamp(),
      });
      nextInviteId += 1;

      return { expiresAt: resolvedExpiresAt };
    },

    async issueInvite(roomId: string, inviteToken: string, expiresAt?: string): Promise<{ expiresAt: string }> {
      return api.createInvite(roomId, inviteToken, expiresAt);
    },

    async getInviteManifest(inviteToken: string): Promise<InviteManifest> {
      const invite = invites.get(hashInviteToken(inviteToken));
      if (!invite) {
        throw new InviteError("Invite not found", 404, "invite_not_found");
      }

      const room = await ensureInviteUsable(invite);
      const openingMessage = getOpeningMessageForRoom(room);
      return {
        roomId: room.id,
        status: deriveInviteStatus(room),
        openingMessage: openingMessage?.content ?? "",
        expiresAt: invite.expires_at,
      };
    },

    async claimInvite(inviteToken: string, idempotencyKey: string): Promise<InviteClaimResult> {
      const invite = invites.get(hashInviteToken(inviteToken));
      if (!invite) {
        throw new InviteError("Invite not found", 404, "invite_not_found");
      }

      const room = getRoomOrThrow(invite.room_id);
      if (invite.claimed_at !== null) {
        if (invite.claim_idempotency_key === idempotencyKey) {
          const sessionToken = invite.claim_session_token
            ?? (invite.participant_role === "host"
              ? room.host_token
              : invite.claim_guest_token ?? room.guest_token);
          if (!sessionToken) {
            throw new InviteError("Invite claim state is invalid", 500, "invite_claim_invalid");
          }

          return {
            roomId: room.id,
            role: invite.participant_role,
            sessionToken,
            ...(invite.participant_role === "guest" ? { guestToken: sessionToken } : {}),
            status: deriveInviteStatus(room),
          };
        }

        throw new InviteError("Invite has already been claimed", 409, "invite_already_claimed");
      }

      await ensureInviteUsable(invite);

      if (invite.participant_role === "guest" && room.guest_token !== null) {
        throw new InviteError("Invite has already been claimed", 409, "invite_already_claimed");
      }

      const sessionToken = invite.participant_role === "host"
        ? room.host_token
        : (room.guest_token ?? crypto.randomUUID());

      if (invite.participant_role === "guest") {
        room.guest_token = sessionToken;
      }

      invite.claimed_at = currentTimestamp();
      invite.claim_idempotency_key = idempotencyKey;
      invite.claim_session_token = sessionToken;
      invite.claim_guest_token = invite.participant_role === "guest" ? sessionToken : null;
      await api.touchRoomActivity(room.id);

      return {
        roomId: room.id,
        role: invite.participant_role,
        sessionToken,
        ...(invite.participant_role === "guest" ? { guestToken: sessionToken } : {}),
        status: deriveInviteStatus(room),
      };
    },

    async sweepExpiredRooms(now: Date = new Date()): Promise<number> {
      const cutoff = now.getTime() - MAX_AGE_MS;
      let deletedCount = 0;

      for (const room of [...rooms.values()]) {
        const createdAt = new Date(room.created_at).getTime();
        if ((room.status === "closed" || room.status === "expired") && createdAt < cutoff) {
          rooms.delete(room.id);
          messages.delete(room.id);
          for (const [tokenHash, invite] of invites.entries()) {
            if (invite.room_id === room.id) {
              invites.delete(tokenHash);
            }
          }
          deletedCount += 1;
        }
      }

      return deletedCount;
    },
  };

  return api;
}
