import type { Role, CloseReason, ServerMessage } from "../types.js";
import type { ServerWebSocket } from "bun";
import type { DbLayer } from "../db/interface.js";

export interface WsData {
  roomId: string;
  role: Role;
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
  private db: DbLayer;

  constructor(db: DbLayer) {
    this.db = db;
  }

  addConnection(roomId: string, role: Role, ws: ServerWebSocket<WsData>): void {
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

  removeConnection(roomId: string, role: Role): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room[role] = null;
  }

  getOtherParticipant(roomId: string, role: Role): ServerWebSocket<WsData> | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return role === "host" ? room.guest : room.host;
  }

  getConnection(roomId: string, role: Role): ServerWebSocket<WsData> | null {
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

  handleMessage(roomId: string, senderRole: Role, content: string): boolean {
    if (content.length > MAX_MESSAGE_SIZE) {
      return false;
    }

    this.db.saveMessage(roomId, senderRole, content);

    const other = this.getOtherParticipant(roomId, senderRole);
    if (other) {
      sendJson(other, { type: "message", content });
    }

    this.resetIdleTimeout(roomId);
    return true;
  }

  handleEnd(roomId: string, senderRole: Role): void {
    this.db.closeRoom(roomId, "closed");

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

  handleDisconnect(roomId: string, disconnectedRole: Role): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    this.db.closeRoom(roomId, "closed");

    const otherRole: Role = disconnectedRole === "host" ? "guest" : "host";
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
      this.db.closeRoom(roomId, "timeout");
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

    // Activate the room in DB
    this.db.activateRoom(roomId);

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

    this.db.closeRoom(roomId, reason);

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
