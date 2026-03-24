import type { Sender, CloseReason, ServerMessage } from "@agentmeets/shared";
import type { ServerWebSocket } from "bun";
import { Database } from "bun:sqlite";
import { closeRoom, saveMessage } from "../db/index.js";

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
    join?: Timer;
    idle?: Timer;
    hard?: Timer;
  };
}

interface RelayMessageInput {
  clientMessageId: string;
  replyToMessageId: number | null;
  content: string;
}

const DEFAULT_JOIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HARD_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_MESSAGE_SIZE = 100 * 1024; // 100KB

export class RoomManager {
  private rooms = new Map<string, ActiveRoom>();
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  addConnection(roomId: string, role: Sender, ws: ServerWebSocket<WsData>): void {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { roomId, host: null, guest: null, isActive: false, timers: {} };
      this.rooms.set(roomId, room);
    }

    room[role] = ws;

    if (role === "host") {
      this.startJoinTimeout(roomId);
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
    clearTimeout(room.timers.join);
    clearTimeout(room.timers.idle);
    clearTimeout(room.timers.hard);
    this.rooms.delete(roomId);
  }

  handleMessage(roomId: string, senderRole: Sender, message: RelayMessageInput): boolean {
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

    this.resetIdleTimeout(roomId);
    return true;
  }

  handleEnd(roomId: string, senderRole: Sender): void {
    closeRoom(this.db, roomId, "user_ended");

    const other = this.getOtherParticipant(roomId, senderRole);
    if (other) {
      sendJson(other, { type: "ended", reason: "user_ended" });
    }

    const sender = this.getConnection(roomId, senderRole);
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

    closeRoom(this.db, roomId, "disconnected");

    const otherRole: Sender = disconnectedRole === "host" ? "guest" : "host";
    const other = room[otherRole];
    if (other) {
      sendJson(other, { type: "ended", reason: "disconnected" });
    }

    this.cleanupRoom(roomId);

    if (other) {
      other.close(1000, "Other participant disconnected");
    }
  }

  // --- Timeout management ---

  private startJoinTimeout(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.timers.join = setTimeout(() => {
      closeRoom(this.db, roomId, "timeout");
      if (room.host) {
        sendJson(room.host, { type: "ended", reason: "timeout" });
      }
      this.cleanupRoom(roomId);
      if (room.host) {
        room.host.close(1000, "Join timeout");
      }
    }, DEFAULT_JOIN_TIMEOUT_MS);
  }

  private maybeActivateRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.isActive || !room.host || !room.guest) return;

    room.isActive = true;
    clearTimeout(room.timers.join);
    room.timers.join = undefined;

    sendJson(room.host, { type: "room_active" });
    sendJson(room.guest, { type: "room_active" });

    this.resetIdleTimeout(roomId);
    this.startHardTimeout(roomId);
  }

  private resetIdleTimeout(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    clearTimeout(room.timers.idle);
    room.timers.idle = setTimeout(() => {
      this.expireRoom(roomId, "timeout");
    }, DEFAULT_IDLE_TIMEOUT_MS);
  }

  private startHardTimeout(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.timers.hard = setTimeout(() => {
      this.expireRoom(roomId, "timeout");
    }, DEFAULT_HARD_TIMEOUT_MS);
  }

  private expireRoom(roomId: string, reason: CloseReason): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    closeRoom(this.db, roomId, reason);

    const msg: ServerMessage = { type: "ended", reason };
    const host = room.host;
    const guest = room.guest;

    this.cleanupRoom(roomId);

    if (host) {
      sendJson(host, msg);
      host.close(1000, `Room ${reason}`);
    }
    if (guest) {
      sendJson(guest, msg);
      guest.close(1000, `Room ${reason}`);
    }
  }
}

function sendJson(ws: ServerWebSocket<WsData>, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}
