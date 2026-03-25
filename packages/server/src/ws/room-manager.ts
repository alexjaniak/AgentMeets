import type { Sender, CloseReason, ServerMessage } from "@agentmeets/shared";
import type { ServerWebSocket } from "bun";
import { Database } from "bun:sqlite";
import { closeRoom, saveMessage, joinRoom } from "../db/index.js";

export interface WsData {
  roomId: string;
  role: Sender;
}

interface ActiveRoom {
  roomId: string;
  host: ServerWebSocket<WsData> | null;
  guest: ServerWebSocket<WsData> | null;
  timers: {
    join?: Timer;
    idle?: Timer;
    hard?: Timer;
  };
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
      room = { roomId, host: null, guest: null, timers: {} };
      this.rooms.set(roomId, room);
    }

    room[role] = ws;

    if (role === "host") {
      this.startJoinTimeout(roomId);
    } else if (role === "guest") {
      this.onGuestJoined(roomId);
    }
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

  handleMessage(roomId: string, senderRole: Sender, content: string): boolean {
    if (Buffer.byteLength(content, "utf8") > MAX_MESSAGE_SIZE) {
      return false;
    }

    saveMessage(this.db, roomId, senderRole, content);

    const other = this.getOtherParticipant(roomId, senderRole);
    if (other) {
      sendJson(other, { type: "message", content });
    }

    this.resetIdleTimeout(roomId);
    return true;
  }

  handleEnd(roomId: string, senderRole: Sender): void {
    closeRoom(this.db, roomId, "closed");

    const other = this.getOtherParticipant(roomId, senderRole);
    if (other) {
      sendJson(other, { type: "ended", reason: "closed" });
      other.close(1000, "Room closed");
    }

    const sender = this.getConnection(roomId, senderRole);
    if (sender) {
      sender.close(1000, "Room closed");
    }

    this.cleanupRoom(roomId);
  }

  handleDisconnect(roomId: string, disconnectedRole: Sender): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    closeRoom(this.db, roomId, "closed");

    const otherRole: Sender = disconnectedRole === "host" ? "guest" : "host";
    const other = room[otherRole];
    if (other) {
      sendJson(other, { type: "ended", reason: "closed" });
      other.close(1000, "Other participant disconnected");
    }

    this.cleanupRoom(roomId);
  }

  // --- Timeout management ---

  private startJoinTimeout(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.timers.join = setTimeout(() => {
      closeRoom(this.db, roomId, "timeout");
      if (room.host) {
        sendJson(room.host, { type: "ended", reason: "timeout" });
        room.host.close(1000, "Join timeout");
      }
      this.cleanupRoom(roomId);
    }, DEFAULT_JOIN_TIMEOUT_MS);
  }

  private onGuestJoined(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    // Cancel join timeout
    clearTimeout(room.timers.join);
    room.timers.join = undefined;

    // Room activation (waiting → active) is handled by the REST API's join
    // endpoint, which calls joinRoom() to set the guest_token and status.
    // By the time the guest connects via WebSocket, the room is already active.

    // Notify host
    if (room.host) {
      sendJson(room.host, { type: "joined" });
    }

    // Start idle and hard timeouts
    this.resetIdleTimeout(roomId);
    this.startHardTimeout(roomId);
  }

  private resetIdleTimeout(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    clearTimeout(room.timers.idle);
    room.timers.idle = setTimeout(() => {
      this.expireRoom(roomId, "idle");
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
    if (room.host) {
      sendJson(room.host, msg);
      room.host.close(1000, `Room ${reason}`);
    }
    if (room.guest) {
      sendJson(room.guest, msg);
      room.guest.close(1000, `Room ${reason}`);
    }

    this.cleanupRoom(roomId);
  }
}

function sendJson(ws: ServerWebSocket<WsData>, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}
