import type { Sender, CloseReason, ServerMessage } from "@agentmeets/shared";
import type { ServerWebSocket } from "bun";
import { Database } from "bun:sqlite";
import { activateRoom, closeRoom, expireRoom, saveMessage } from "../db/index.js";
import { getOpeningMessage } from "../db/messages.js";

export interface WsData {
  roomId: string;
  role: Sender;
}

interface ActiveRoom {
  roomId: string;
  host: ServerWebSocket<WsData> | null;
  guest: ServerWebSocket<WsData> | null;
  isActive: boolean;
  timers: {
    expiry?: Timer;
    idle?: Timer;
  };
}

interface RelayMessageInput {
  clientMessageId: string;
  replyToMessageId: number | null;
  content: string;
}

interface RoomManagerOptions {
  idleTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_MESSAGE_SIZE = 100 * 1024; // 100KB

export class RoomManager {
  private rooms = new Map<string, ActiveRoom>();
  private db: Database;
  private idleTimeoutMs: number;

  constructor(db: Database, options: RoomManagerOptions = {}) {
    this.db = db;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  addConnection(roomId: string, role: Sender, ws: ServerWebSocket<WsData>): void {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { roomId, host: null, guest: null, isActive: false, timers: {} };
      this.rooms.set(roomId, room);
    }

    room[role] = ws;

    if (!room.timers.expiry && !room.isActive) {
      this.startWaitingExpiryTimer(roomId);
    }

    this.maybeActivateRoom(roomId);
  }

  removeConnection(roomId: string, role: Sender): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room[role] = null;
  }

  getOtherParticipant(roomId: string, role: Sender): ServerWebSocket<WsData> | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return role === "host" ? room.guest : room.host;
  }

  getConnection(roomId: string, role: Sender): ServerWebSocket<WsData> | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return room[role];
  }

  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  cleanupRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    clearTimeout(room.timers.expiry);
    clearTimeout(room.timers.idle);
    this.rooms.delete(roomId);
  }

  handleMessage(roomId: string, senderRole: Sender, message: RelayMessageInput): boolean {
    const room = this.rooms.get(roomId);
    if (Buffer.byteLength(message.content, "utf8") > MAX_MESSAGE_SIZE) {
      return false;
    }

    const persisted = saveMessage(this.db, roomId, senderRole, message.content);
    const sender = this.getConnection(roomId, senderRole);
    if (sender) {
      sendJson(sender, {
        type: "ack",
        messageId: persisted.id,
        clientMessageId: message.clientMessageId,
        replyToMessageId: message.replyToMessageId,
        createdAt: persisted.created_at,
      });
    }

    const other = this.getOtherParticipant(roomId, senderRole);
    if (other) {
      sendJson(other, {
        type: "message",
        messageId: persisted.id,
        sender: senderRole,
        clientMessageId: message.clientMessageId,
        replyToMessageId: message.replyToMessageId,
        content: message.content,
        createdAt: persisted.created_at,
      });
    }

    if (room?.isActive) {
      this.resetIdleTimeout(roomId);
    }
    return true;
  }

  handleEnd(roomId: string, senderRole: Sender): void {
    closeRoom(this.db, roomId, "user_ended");

    const other = this.getOtherParticipant(roomId, senderRole);
    const sender = this.getConnection(roomId, senderRole);
    if (other) {
      sendJson(other, { type: "ended", reason: "user_ended" });
    }
    if (sender) {
      sendJson(sender, { type: "ended", reason: "user_ended" });
    }
    this.cleanupRoom(roomId);

    if (other) {
      other.close(1000, "Room closed");
    }
    if (sender) {
      sender.close(1000, "Room closed");
    }
  }

  handleDisconnect(roomId: string, disconnectedRole: Sender): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (!room.isActive) {
      const hasConnections = room.host || room.guest;
      if (!hasConnections) {
        this.cleanupRoom(roomId);
      }
      return;
    }

    closeRoom(this.db, roomId, "disconnected");

    const otherRole: Sender = disconnectedRole === "host" ? "guest" : "host";
    const other = room[otherRole];
    if (other) {
      sendJson(other, { type: "ended", reason: "disconnected" });
    }

    this.cleanupRoom(roomId);

    if (other) {
      other.close(1000, "disconnected");
    }
  }

  // --- Timeout management ---

  private startWaitingExpiryTimer(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const expiresAt = this.getInviteExpiry(roomId);
    if (!expiresAt) {
      return;
    }

    room.timers.expiry = setTimeout(() => {
      this.expireRoom(roomId);
    }, Math.max(0, expiresAt.getTime() - Date.now()));
  }

  private maybeActivateRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.isActive || !room.host || !room.guest) return;

    const inviteExpiry = this.getInviteExpiry(roomId);
    if (inviteExpiry && inviteExpiry.getTime() <= Date.now()) {
      clearTimeout(room.timers.expiry);
      room.timers.expiry = undefined;
      this.expireRoom(roomId);
      return;
    }

    room.isActive = true;
    clearTimeout(room.timers.expiry);
    room.timers.expiry = undefined;
    activateRoom(this.db, roomId);

    sendJson(room.host, { type: "room_active" });
    sendJson(room.guest, { type: "room_active" });
    this.replayOpeningMessage(roomId, room.guest);

    this.resetIdleTimeout(roomId);
  }

  private resetIdleTimeout(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    clearTimeout(room.timers.idle);
    room.timers.idle = setTimeout(() => {
      this.expireRoom(roomId);
    }, this.idleTimeoutMs);
  }

  private replayOpeningMessage(roomId: string, guest: ServerWebSocket<WsData>): void {
    const openingMessage = getOpeningMessage(this.db, roomId);
    if (!openingMessage) return;

    sendJson(guest, {
      type: "message",
      messageId: openingMessage.id,
      sender: "host",
      clientMessageId: `persisted:${openingMessage.id}`,
      replyToMessageId: null,
      content: openingMessage.content,
      createdAt: openingMessage.created_at,
    });
  }

  private getInviteExpiry(roomId: string): Date | null {
    const row = this.db
      .prepare(
        `SELECT MIN(expires_at) AS expires_at
         FROM invites
         WHERE room_id = ?`,
      )
      .get(roomId) as { expires_at: string | null } | null;

    if (!row?.expires_at) {
      return null;
    }

    return new Date(row.expires_at);
  }

  private expireRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    expireRoom(this.db, roomId);

    const msg: ServerMessage = { type: "ended", reason: "expired" };
    const host = room.host;
    const guest = room.guest;

    this.cleanupRoom(roomId);

    if (host) {
      sendJson(host, msg);
      host.close(1000, "Room expired");
    }
    if (guest) {
      sendJson(guest, msg);
      guest.close(1000, "Room expired");
    }
  }
}

function sendJson(ws: ServerWebSocket<WsData>, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}
