import type {
  Message,
  RoomStatus,
  Sender,
  StoredCloseReason,
  StoredRoom,
} from "@agentmeets/shared";

export interface InviteManifest {
  roomId: string;
  status: RoomStatus;
  openingMessage: string;
  expiresAt: string;
}

export interface InviteClaimResult {
  roomId: string;
  role: Sender;
  sessionToken: string;
  guestToken?: string;
  status: RoomStatus;
}

export interface PublicRoomSnapshot {
  roomId: string;
  roomStem: string;
  roomStatus: "waiting" | "active" | "closed" | "expired";
  hostConnectedAt: string | null;
  guestConnectedAt: string | null;
  inviteExpiresAt: string | null;
}

export interface StoredInvite {
  id: number;
  room_id: string;
  participant_role: Sender;
  token_hash: string;
  expires_at: string;
  claimed_at: string | null;
  claim_idempotency_key: string | null;
  claim_session_token: string | null;
  claim_guest_token: string | null;
  created_at: string;
}

export interface CreateRoomInput {
  id: string;
  hostToken: string;
  openingMessage?: string;
  roomStem?: string;
}

export interface CreateRoomWithInvitesInput {
  roomId: string;
  roomStem: string;
  hostToken: string;
  openingMessage: string;
  inviteExpiresAt: string;
}

export interface RoomTokenLookup {
  room: StoredRoom;
  role: Sender;
}

export class InviteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "InviteError";
  }
}

export interface AgentMeetsStore {
  createRoom(input: CreateRoomInput): Promise<StoredRoom>;
  createRoomWithInvites(input: CreateRoomWithInvitesInput): Promise<void>;
  getRoom(id: string): Promise<StoredRoom | null>;
  getPublicRoomSnapshot(roomStem: string): Promise<PublicRoomSnapshot | null>;
  joinRoom(id: string, guestToken: string): Promise<StoredRoom>;
  activateRoom(id: string): Promise<StoredRoom>;
  closeRoom(id: string, reason: StoredCloseReason): Promise<void>;
  expireRoom(id: string): Promise<void>;
  markRoleConnected(roomId: string, role: Sender): Promise<void>;
  clearRoleConnected(roomId: string, role: Sender): Promise<void>;
  touchRoomActivity(id: string): Promise<void>;
  getRoomByToken(token: string): Promise<RoomTokenLookup | null>;
  saveMessage(roomId: string, sender: Sender, content: string): Promise<Message>;
  getMessages(roomId: string): Promise<Message[]>;
  getPendingMessages(roomId: string): Promise<Message[]>;
  getReplayMessages(roomId: string, role: Sender): Promise<Message[]>;
  getOpeningMessage(roomId: string): Promise<Message | null>;
  createInvite(roomId: string, inviteToken: string, expiresAt?: string): Promise<{ expiresAt: string }>;
  issueInvite(roomId: string, inviteToken: string, expiresAt?: string): Promise<{ expiresAt: string }>;
  getInviteManifest(inviteToken: string): Promise<InviteManifest>;
  claimInvite(inviteToken: string, idempotencyKey: string): Promise<InviteClaimResult>;
  sweepExpiredRooms(now?: Date): Promise<number>;
}
