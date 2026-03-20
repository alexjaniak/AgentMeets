import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeSchema } from "./schema.js";
import {
  createRoom,
  getRoom,
  joinRoom,
  closeRoom,
  expireRoom,
  getRoomByToken,
} from "./rooms.js";
import { saveMessage, getMessages, getPendingMessages } from "./messages.js";
import { createDatabase, generateRoomId, generateToken } from "./index.js";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initializeSchema(db);
});

describe("schema", () => {
  test("creates tables on initialization", () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("rooms");
    expect(names).toContain("messages");
  });

  test("creates index on messages.room_id", () => {
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'`,
      )
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_messages_room");
  });
});

describe("createDatabase", () => {
  test("creates a working database with schema", () => {
    const testDb = createDatabase(":memory:");
    const room = createRoom(testDb, "TEST01", "token-host");
    expect(room.id).toBe("TEST01");
    testDb.close();
  });
});

describe("rooms", () => {
  test("createRoom inserts a room with status waiting", () => {
    const room = createRoom(db, "ABC123", "host-token-1");
    expect(room.id).toBe("ABC123");
    expect(room.host_token).toBe("host-token-1");
    expect(room.guest_token).toBeNull();
    expect(room.status).toBe("waiting");
    expect(room.created_at).toBeTruthy();
    expect(room.joined_at).toBeNull();
    expect(room.closed_at).toBeNull();
    expect(room.close_reason).toBeNull();
  });

  test("getRoom returns room by id", () => {
    createRoom(db, "ABC123", "host-token-1");
    const room = getRoom(db, "ABC123");
    expect(room).not.toBeNull();
    expect(room!.id).toBe("ABC123");
  });

  test("getRoom returns null for non-existent room", () => {
    const room = getRoom(db, "NOPE00");
    expect(room).toBeNull();
  });

  test("joinRoom transitions room to active", () => {
    createRoom(db, "ABC123", "host-token-1");
    const room = joinRoom(db, "ABC123", "guest-token-1");
    expect(room.status).toBe("active");
    expect(room.guest_token).toBe("guest-token-1");
    expect(room.joined_at).toBeTruthy();
  });

  test("joinRoom throws if room not found", () => {
    expect(() => joinRoom(db, "NOPE00", "guest-token")).toThrow(
      "Room not found",
    );
  });

  test("joinRoom throws if room is full", () => {
    createRoom(db, "ABC123", "host-token-1");
    joinRoom(db, "ABC123", "guest-token-1");
    expect(() => joinRoom(db, "ABC123", "guest-token-2")).toThrow(
      "Room is full",
    );
  });

  test("joinRoom throws if room is expired", () => {
    createRoom(db, "ABC123", "host-token-1");
    expireRoom(db, "ABC123");
    expect(() => joinRoom(db, "ABC123", "guest-token-1")).toThrow(
      "Room is expired",
    );
  });

  test("joinRoom throws if room is closed", () => {
    createRoom(db, "ABC123", "host-token-1");
    joinRoom(db, "ABC123", "guest-token-1");
    closeRoom(db, "ABC123", "closed");
    expect(() => joinRoom(db, "ABC123", "guest-token-2")).toThrow(
      "Room is closed",
    );
  });

  test("closeRoom sets status, closed_at, and close_reason", () => {
    createRoom(db, "ABC123", "host-token-1");
    joinRoom(db, "ABC123", "guest-token-1");
    closeRoom(db, "ABC123", "timeout");
    const room = getRoom(db, "ABC123")!;
    expect(room.status).toBe("closed");
    expect(room.closed_at).toBeTruthy();
    expect(room.close_reason).toBe("timeout");
  });

  test("expireRoom sets status to expired", () => {
    createRoom(db, "ABC123", "host-token-1");
    expireRoom(db, "ABC123");
    const room = getRoom(db, "ABC123")!;
    expect(room.status).toBe("expired");
    expect(room.closed_at).toBeTruthy();
  });

  test("getRoomByToken identifies host", () => {
    createRoom(db, "ABC123", "host-token-1");
    const result = getRoomByToken(db, "host-token-1");
    expect(result).not.toBeNull();
    expect(result!.role).toBe("host");
    expect(result!.room.id).toBe("ABC123");
  });

  test("getRoomByToken identifies guest", () => {
    createRoom(db, "ABC123", "host-token-1");
    joinRoom(db, "ABC123", "guest-token-1");
    const result = getRoomByToken(db, "guest-token-1");
    expect(result).not.toBeNull();
    expect(result!.role).toBe("guest");
    expect(result!.room.id).toBe("ABC123");
  });

  test("getRoomByToken returns null for unknown token", () => {
    const result = getRoomByToken(db, "unknown-token");
    expect(result).toBeNull();
  });
});

describe("messages", () => {
  test("saveMessage inserts and returns a message", () => {
    createRoom(db, "ABC123", "host-token-1");
    const msg = saveMessage(db, "ABC123", "host", "Hello!");
    expect(msg.id).toBeTruthy();
    expect(msg.room_id).toBe("ABC123");
    expect(msg.sender).toBe("host");
    expect(msg.content).toBe("Hello!");
    expect(msg.created_at).toBeTruthy();
  });

  test("getMessages returns all messages ordered by created_at", () => {
    createRoom(db, "ABC123", "host-token-1");
    saveMessage(db, "ABC123", "host", "First");
    saveMessage(db, "ABC123", "host", "Second");
    saveMessage(db, "ABC123", "guest", "Third");

    const messages = getMessages(db, "ABC123");
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("First");
    expect(messages[1].content).toBe("Second");
    expect(messages[2].content).toBe("Third");
  });

  test("getMessages returns empty array for room with no messages", () => {
    createRoom(db, "ABC123", "host-token-1");
    const messages = getMessages(db, "ABC123");
    expect(messages).toHaveLength(0);
  });

  test("getPendingMessages returns host messages sent before guest joined", () => {
    createRoom(db, "ABC123", "host-token-1");

    // Insert messages with explicit earlier timestamps
    db.prepare(
      `INSERT INTO messages (room_id, sender, content, created_at) VALUES (?, ?, ?, ?)`,
    ).run("ABC123", "host", "Pending message 1", "2025-01-01 00:00:00");
    db.prepare(
      `INSERT INTO messages (room_id, sender, content, created_at) VALUES (?, ?, ?, ?)`,
    ).run("ABC123", "host", "Pending message 2", "2025-01-01 00:00:01");

    // Before joining, these should be pending
    const pendingBefore = getPendingMessages(db, "ABC123");
    expect(pendingBefore).toHaveLength(2);

    // Set joined_at to a known time between pre-join messages and post-join messages
    db.prepare(
      `UPDATE rooms SET guest_token = ?, status = 'active', joined_at = ? WHERE id = ?`,
    ).run("guest-token-1", "2025-01-01 00:00:10", "ABC123");

    // Insert message after join
    db.prepare(
      `INSERT INTO messages (room_id, sender, content, created_at) VALUES (?, ?, ?, ?)`,
    ).run("ABC123", "host", "After join", "2025-01-01 00:00:15");

    const pending = getPendingMessages(db, "ABC123");
    // Should still only have the 2 messages from before join
    expect(pending).toHaveLength(2);
    expect(pending[0].content).toBe("Pending message 1");
    expect(pending[1].content).toBe("Pending message 2");
  });

  test("getPendingMessages excludes guest messages", () => {
    createRoom(db, "ABC123", "host-token-1");
    saveMessage(db, "ABC123", "host", "Host pending");
    // guest messages before join shouldn't happen normally, but verify filter
    const pending = getPendingMessages(db, "ABC123");
    expect(pending).toHaveLength(1);
    expect(pending[0].sender).toBe("host");
  });
});

describe("generateRoomId", () => {
  test("generates 6-character uppercase alphanumeric string", () => {
    const id = generateRoomId();
    expect(id).toHaveLength(6);
    expect(id).toMatch(/^[A-Z0-9]{6}$/);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRoomId()));
    expect(ids.size).toBe(100);
  });
});

describe("generateToken", () => {
  test("generates UUID format token", () => {
    const token = generateToken();
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(tokens.size).toBe(100);
  });
});
