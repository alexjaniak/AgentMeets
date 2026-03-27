import { Database } from "bun:sqlite";
import { initializeSchema } from "../../src/db/schema.js";
import {
  createRoom,
  getRoom,
  joinRoom,
  closeRoom,
  expireRoom,
} from "../../src/db/rooms.js";
import { saveMessage, getMessages } from "../../src/db/messages.js";
import { generateRoomId, generateToken } from "../../src/db/index.js";
import type { CloseReason, Sender, StoredCloseReason, StoredRoomStatus } from "@agentmeets/shared";

/**
 * Creates a fresh in-memory SQLite database for test isolation.
 * Each test gets its own database — no cross-test contamination.
 */
export function createTestDatabase(): Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

/**
 * TestAgent wraps the DB-level operations that correspond to each MCP tool.
 * This simulates the full MCP tool flow without requiring stdio or a running server.
 */
export class TestAgent {
  private db: Database;
  private roomId: string | null = null;
  private token: string | null = null;
  private role: Sender | null = null;
  private pendingMessages: string[] = [];
  private ended = false;
  private endReason: string | null = null;

  constructor(db: Database) {
    this.db = db;
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

  get currentRole(): Sender | null {
    return this.role;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /**
   * Simulates the create_meet MCP tool.
   * Creates a room and connects as host.
   */
  async createMeet(timeout?: number): Promise<{ roomId: string }> {
    const roomId = generateRoomId();
    const hostToken = generateToken();
    createRoom(this.db, roomId, hostToken);
    this.roomId = roomId;
    this.token = hostToken;
    this.role = "host";

    if (timeout !== undefined) {
      setTimeout(() => {
        const room = getRoom(this.db, roomId);
        if (room && room.status === "waiting") {
          expireRoom(this.db, roomId);
          this.ended = true;
          this.endReason = "timeout";
        }
      }, timeout * 1000);
    }

    return { roomId };
  }

  /**
   * Simulates the join_meet MCP tool.
   * Joins an existing room as guest and retrieves pending messages.
   */
  async joinMeet(
    roomId: string,
  ): Promise<{ pending: string[]; status: string }> {
    const room = getRoom(this.db, roomId);
    if (!room) {
      throw new JoinError("Room not found", 404);
    }
    if (room.status === "expired") {
      throw new JoinError("Room is expired", 410);
    }
    if (room.status === "closed") {
      throw new JoinError("Room is closed", 410);
    }
    if (room.guest_token !== null) {
      throw new JoinError("Room is full", 409);
    }

    // Capture host messages before joining — these are the "pending" messages
    // that were sent while the host was waiting. We grab them before joinRoom()
    // because getPendingMessages relies on timestamp comparison which can be
    // unreliable at sub-second precision in SQLite.
    const preJoinMessages = getMessages(this.db, roomId)
      .filter((m) => m.sender === "host")
      .map((m) => m.content);

    const guestToken = generateToken();
    joinRoom(this.db, roomId, guestToken);
    this.roomId = roomId;
    this.token = guestToken;
    this.role = "guest";

    this.pendingMessages = preJoinMessages;

    return { pending: preJoinMessages, status: "connected" };
  }

  /**
   * Simulates the send_and_wait MCP tool.
   * Sends a message and returns the next message from the other party,
   * or an ended status if the room has been closed.
   */
  async sendAndWait(
    message: string,
    timeout?: number,
  ): Promise<{ reply: string | null; status: string; reason?: string }> {
    if (!this.roomId || !this.role) {
      throw new Error("Not connected to a room");
    }

    // Check if room is already ended
    const roomBefore = getRoom(this.db, this.roomId);
    if (
      roomBefore &&
      (roomBefore.status === "closed" || roomBefore.status === "expired")
    ) {
      return {
        reply: null,
        status: "ended",
        reason: mapStoredEndReason(roomBefore.status, roomBefore.close_reason),
      };
    }

    // Save outgoing message
    saveMessage(this.db, this.roomId, this.role, message);

    // In a real server, this would block on WebSocket.
    // For DB-level E2E, we return a function-based approach:
    // the caller orchestrates the turn-taking.
    return { reply: null, status: "waiting" };
  }

  /**
   * Checks for a reply from the other agent.
   * Returns the reply if available, or ended status if room closed.
   */
  getReply(): { reply: string | null; status: string; reason?: string } {
    if (!this.roomId || !this.role) {
      throw new Error("Not connected to a room");
    }

    const room = getRoom(this.db, this.roomId);
    if (
      room &&
      (room.status === "closed" || room.status === "expired")
    ) {
      return {
        reply: null,
        status: "ended",
        reason: mapStoredEndReason(room.status, room.close_reason),
      };
    }

    const otherRole: Sender = this.role === "host" ? "guest" : "host";
    const allMessages = getMessages(this.db, this.roomId);
    const myMessages = allMessages.filter((m) => m.sender === this.role);
    const otherMessages = allMessages.filter((m) => m.sender === otherRole);

    // The reply is the latest message from the other party that comes after
    // our latest message
    if (otherMessages.length > myMessages.length) {
      return { reply: otherMessages[otherMessages.length - 1].content, status: "ok" };
    }
    if (otherMessages.length === myMessages.length && otherMessages.length > 0) {
      return { reply: otherMessages[otherMessages.length - 1].content, status: "ok" };
    }

    return { reply: null, status: "waiting" };
  }

  /**
   * Simulates the end_meet MCP tool.
   * Closes the room from this agent's side.
   */
  async endMeet(): Promise<{ status: string }> {
    if (!this.roomId) {
      throw new Error("Not connected to a room");
    }
    closeRoom(this.db, this.roomId, "user_ended");
    this.ended = true;
    this.endReason = "user_ended";
    return { status: "ended" };
  }
}

export class JoinError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "JoinError";
    this.statusCode = statusCode;
  }
}

function mapStoredEndReason(
  status: StoredRoomStatus,
  reason: StoredCloseReason | null,
): CloseReason {
  if (status === "expired") {
    return "expired";
  }

  switch (reason) {
    case "user_ended":
      return "user_ended";
    case "disconnected":
      return "disconnected";
    case "timeout":
    case "idle":
      return "timeout";
    case "expired":
      return "expired";
    case "join_failed":
      return "join_failed";
    case "closed":
    case null:
      return "user_ended";
  }
}
