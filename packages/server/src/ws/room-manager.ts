import type {
  Sender,
  ServerMessage,
  StoredRoomStatus,
} from "@agentmeets/shared";
import type { ServerWebSocket } from "bun";
import type { AgentMeetsStore } from "../db/store.js";

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

interface RoomLifecycleState {
  roomStatus: StoredRoomStatus;
  inviteExpiresAt: string | null;
  lastActivityAt: string | null;
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_MESSAGE_SIZE = 100 * 1024; // 100KB
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class RoomManager {
  private readonly rooms = new Map<string, ActiveRoom>();
  private readonly roomTasks = new Map<string, Promise<void>>();
  private readonly store: AgentMeetsStore;
  private readonly idleTimeoutMs: number;

  constructor(store: AgentMeetsStore, options: RoomManagerOptions = {}) {
    this.store = store;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async addConnection(
    roomId: string,
    role: Sender,
    ws: ServerWebSocket<WsData>,
  ): Promise<void> {
    const room = this.ensureRoom(roomId);
    room[role] = ws;

    await this.serializeRoom(roomId, async () => {
      await this.store.markRoleConnected(roomId, role);
      if (this.getConnection(roomId, role) !== ws) {
        return;
      }

      const lifecycle = await this.getRoomLifecycleState(roomId);
      if (lifecycle?.roomStatus === "expired") {
        await this.expireRoomLocked(roomId);
        return;
      }
      if (await this.expireWaitingRoomIfNeededFromLifecycle(roomId, lifecycle)) {
        return;
      }

      if (!room.isActive && lifecycle && this.usesWaitingInviteExpiry(lifecycle) && !room.timers.expiry) {
        this.startWaitingExpiryTimer(roomId, lifecycle);
      }

      if (role === "guest" && room[role] === ws) {
        await this.replayRoomHistory(roomId, role, ws);
      }

      await this.maybeActivateRoom(roomId);

      if (role === "host" && room[role] === ws) {
        await this.replayRoomHistory(roomId, role, ws);
      }

      const refreshedLifecycle = await this.getRoomLifecycleState(roomId);
      if (refreshedLifecycle && this.usesActiveIdleTimeout(refreshedLifecycle)) {
        this.scheduleIdleTimeout(roomId, refreshedLifecycle);
      }
    });
  }

  removeConnection(roomId: string, role: Sender): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    room[role] = null;
    void this.serializeRoom(roomId, async () => {
      await this.store.clearRoleConnected(roomId, role);
    }).catch(logRoomManagerError);
  }

  shutdown(): void {
    for (const roomId of this.rooms.keys()) {
      this.cleanupRoom(roomId);
    }
  }

  getOtherParticipant(roomId: string, role: Sender): ServerWebSocket<WsData> | null {
    const room = this.rooms.get(roomId);
    if (!room) {
      return null;
    }
    return role === "host" ? room.guest : room.host;
  }

  getConnection(roomId: string, role: Sender): ServerWebSocket<WsData> | null {
    const room = this.rooms.get(roomId);
    if (!room) {
      return null;
    }
    return room[role];
  }

  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  cleanupRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    clearTimeout(room.timers.expiry);
    clearTimeout(room.timers.idle);
    this.rooms.delete(roomId);
  }

  async handleMessage(
    roomId: string,
    senderRole: Sender,
    message: RelayMessageInput,
  ): Promise<boolean> {
    if (Buffer.byteLength(message.content, "utf8") > MAX_MESSAGE_SIZE) {
      return false;
    }

    await this.serializeRoom(roomId, async () => {
      const room = this.rooms.get(roomId);
      const persisted = await this.store.saveMessage(roomId, senderRole, message.content);

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

      const lifecycle = await this.getRoomLifecycleState(roomId);
      if (room?.isActive || (lifecycle && this.usesActiveIdleTimeout(lifecycle))) {
        this.scheduleIdleTimeout(roomId, lifecycle);
      }
    });

    return true;
  }

  async handleEnd(roomId: string, senderRole: Sender): Promise<void> {
    await this.serializeRoom(roomId, async () => {
      await this.store.closeRoom(roomId, "user_ended");

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
    });
  }

  async handleDisconnect(roomId: string, disconnectedRole: Sender): Promise<void> {
    await this.serializeRoom(roomId, async () => {
      const room = this.rooms.get(roomId);
      if (!room) {
        return;
      }

      if (!room.isActive) {
        const hasConnections = room.host || room.guest;
        if (!hasConnections) {
          this.cleanupRoom(roomId);
        }
        return;
      }

      await this.store.closeRoom(roomId, "disconnected");

      const otherRole: Sender = disconnectedRole === "host" ? "guest" : "host";
      const other = room[otherRole];
      if (other) {
        sendJson(other, { type: "ended", reason: "disconnected" });
      }

      this.cleanupRoom(roomId);

      if (other) {
        other.close(1000, "disconnected");
      }
    });
  }

  async expireIdleRoomIfNeeded(roomId: string): Promise<boolean> {
    return this.serializeRoom(roomId, async () => {
      const lifecycle = await this.getRoomLifecycleState(roomId);
      if (!lifecycle) {
        return false;
      }

      if (await this.expireWaitingRoomIfNeededFromLifecycle(roomId, lifecycle)) {
        return true;
      }

      if (!this.usesActiveIdleTimeout(lifecycle)) {
        return false;
      }

      return this.expireIdleRoomIfNeededFromLifecycle(roomId, lifecycle);
    });
  }

  private startWaitingExpiryTimer(roomId: string, lifecycle?: RoomLifecycleState): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    const expiresAt = this.getInviteExpiry(lifecycle ?? null);
    if (!expiresAt) {
      return;
    }

    room.timers.expiry = setTimeout(() => {
      void this.serializeRoom(roomId, async () => {
        const currentRoom = this.rooms.get(roomId);
        if (currentRoom) {
          clearTimeout(currentRoom.timers.expiry);
          currentRoom.timers.expiry = undefined;
        }

        const currentLifecycle = await this.getRoomLifecycleState(roomId);
        if (!currentLifecycle) {
          this.cleanupRoom(roomId);
          return;
        }

        if (!this.usesWaitingInviteExpiry(currentLifecycle)) {
          return;
        }

        await this.expireRoomLocked(roomId);
      }).catch(logRoomManagerError);
    }, clampTimerDelay(expiresAt.getTime() - Date.now()));
  }

  private async maybeActivateRoom(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room || room.isActive || !room.host || !room.guest) {
      return;
    }

    const lifecycle = await this.getRoomLifecycleState(roomId);
    if (await this.expireWaitingRoomIfNeededFromLifecycle(roomId, lifecycle)) {
      clearTimeout(room.timers.expiry);
      room.timers.expiry = undefined;
      return;
    }

    room.isActive = true;
    clearTimeout(room.timers.expiry);
    room.timers.expiry = undefined;

    try {
      await this.store.activateRoom(roomId);
    } catch (error) {
      room.isActive = false;
      throw error;
    }

    sendJson(room.host, { type: "room_active", roomId });
    sendJson(room.guest, { type: "room_active", roomId });
    this.scheduleIdleTimeout(roomId);
  }

  private scheduleIdleTimeout(
    roomId: string,
    lifecycle?: RoomLifecycleState | null,
  ): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    clearTimeout(room.timers.idle);
    room.timers.idle = undefined;

    const idleExpiry = this.getIdleExpiry(lifecycle ?? null);
    if (!idleExpiry) {
      return;
    }

    room.timers.idle = setTimeout(() => {
      void this.serializeRoom(roomId, async () => {
        const currentLifecycle = await this.getRoomLifecycleState(roomId);
        if (!currentLifecycle) {
          this.cleanupRoom(roomId);
          return;
        }

        if (!this.usesActiveIdleTimeout(currentLifecycle)) {
          this.cleanupRoom(roomId);
          return;
        }

        if (!await this.expireIdleRoomIfNeededFromLifecycle(roomId, currentLifecycle)) {
          this.scheduleIdleTimeout(roomId, currentLifecycle);
        }
      }).catch(logRoomManagerError);
    }, clampTimerDelay(idleExpiry.getTime() - Date.now()));
  }

  private async replayRoomHistory(
    roomId: string,
    role: Sender,
    recipient: ServerWebSocket<WsData>,
  ): Promise<void> {
    for (const message of await this.store.getReplayMessages(roomId, role)) {
      sendJson(recipient, {
        type: "message",
        messageId: message.id,
        sender: message.sender,
        clientMessageId: `persisted:${message.id}`,
        replyToMessageId: null,
        content: message.content,
        createdAt: message.created_at,
      });
    }
  }

  private async getRoomLifecycleState(roomId: string): Promise<RoomLifecycleState | null> {
    const room = await this.store.getRoom(roomId);
    if (!room) {
      return null;
    }

    let inviteExpiresAt: string | null = null;
    if (room.room_stem) {
      const snapshot = await this.store.getPublicRoomSnapshot(room.room_stem);
      inviteExpiresAt = snapshot?.inviteExpiresAt ?? null;
    }

    return {
      roomStatus: room.status,
      lastActivityAt: room.last_activity_at ?? null,
      inviteExpiresAt,
    };
  }

  private getInviteExpiry(lifecycle: RoomLifecycleState | null): Date | null {
    if (!lifecycle?.inviteExpiresAt) {
      return null;
    }

    return new Date(lifecycle.inviteExpiresAt);
  }

  private usesWaitingInviteExpiry(lifecycle: RoomLifecycleState): boolean {
    return lifecycle.roomStatus === "waiting";
  }

  private usesActiveIdleTimeout(lifecycle: RoomLifecycleState): boolean {
    return lifecycle.roomStatus === "active";
  }

  private getIdleExpiry(lifecycle: RoomLifecycleState | null): Date | null {
    if (!lifecycle?.lastActivityAt || !this.usesActiveIdleTimeout(lifecycle)) {
      return null;
    }

    const lastActivityMs = Date.parse(lifecycle.lastActivityAt);
    if (Number.isNaN(lastActivityMs)) {
      return null;
    }

    return new Date(lastActivityMs + this.idleTimeoutMs);
  }

  private async expireWaitingRoomIfNeededFromLifecycle(
    roomId: string,
    lifecycle: RoomLifecycleState | null,
  ): Promise<boolean> {
    if (!lifecycle || !this.usesWaitingInviteExpiry(lifecycle)) {
      return false;
    }

    const inviteExpiry = this.getInviteExpiry(lifecycle);
    if (!inviteExpiry || inviteExpiry.getTime() > Date.now()) {
      return false;
    }

    await this.expireRoomLocked(roomId);
    return true;
  }

  private async expireIdleRoomIfNeededFromLifecycle(
    roomId: string,
    lifecycle: RoomLifecycleState | null,
  ): Promise<boolean> {
    const idleExpiry = this.getIdleExpiry(lifecycle);
    if (!idleExpiry || idleExpiry.getTime() > Date.now()) {
      return false;
    }

    await this.expireRoomLocked(roomId);
    return true;
  }

  private async expireRoomLocked(roomId: string): Promise<void> {
    await this.store.expireRoom(roomId);

    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

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

  private ensureRoom(roomId: string): ActiveRoom {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { roomId, host: null, guest: null, isActive: false, timers: {} };
      this.rooms.set(roomId, room);
    }

    return room;
  }

  private async serializeRoom<T>(
    roomId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.roomTasks.get(roomId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const marker = previous.catch(() => undefined).then(() => gate);
    this.roomTasks.set(roomId, marker);

    try {
      await previous.catch(() => undefined);
      return await task();
    } finally {
      release?.();
      if (this.roomTasks.get(roomId) === marker) {
        this.roomTasks.delete(roomId);
      }
    }
  }
}

function sendJson(ws: ServerWebSocket<WsData>, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function logRoomManagerError(error: unknown): void {
  console.error("RoomManager error", error);
}

function clampTimerDelay(delayMs: number): number {
  return Math.max(0, Math.min(MAX_TIMER_DELAY_MS, delayMs));
}
