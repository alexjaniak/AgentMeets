import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { StoredRoom } from "@agentmeets/shared";
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
import { createInvite, claimInvite } from "./invites.js";
import { createDatabase, generateRoomId, generateToken } from "./index.js";

let db: Database;
const createRoomWithOpeningMessage = createRoom as unknown as (
  db: Database,
  id: string,
  hostToken: string,
  openingMessage: string,
  roomStem?: string,
) => { id: string };

beforeEach(() => {
  db = new Database(":memory:");
  initializeSchema(db);
});

const inniesMigrationRoot = resolveInniesMigrationRoot();
const inniesMigrationPaths = inniesMigrationRoot
  ? [
      path.join(inniesMigrationRoot, "docs/migrations/025_agentmeets_postgres_storage.sql"),
      path.join(inniesMigrationRoot, "docs/migrations/025_agentmeets_postgres_storage_no_extensions.sql"),
    ]
  : [];

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
    expect(names).toContain("invites");
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

  test("adds room opening message linkage and hashed invite storage", () => {
    const roomColumns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
    expect(roomColumns.map((column) => column.name)).toContain("opening_message_id");

    const inviteColumns = db.prepare(`PRAGMA table_info(invites)`).all() as Array<{ name: string }>;
    const inviteColumnNames = inviteColumns.map((column) => column.name);

    expect(inviteColumnNames).toContain("room_id");
    expect(inviteColumnNames).toContain("token_hash");
    expect(inviteColumnNames).toContain("expires_at");
    expect(inviteColumnNames).toContain("claimed_at");
    expect(inviteColumnNames).toContain("claim_idempotency_key");
    expect(inviteColumnNames).not.toContain("token");
  });

  test("adds room stem, last activity, and invite participant role storage", () => {
    const roomColumns = db.prepare(`PRAGMA table_info(rooms)`).all() as Array<{ name: string }>;
    const inviteColumns = db.prepare(`PRAGMA table_info(invites)`).all() as Array<{ name: string }>;

    expect(roomColumns.map((column) => column.name)).toContain("room_stem");
    expect(roomColumns.map((column) => column.name)).toContain("last_activity_at");
    expect(inviteColumns.map((column) => column.name)).toContain("participant_role");
    expect(inviteColumns.map((column) => column.name)).toContain("claim_session_token");
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
  test("createRoom persists a high-entropy room stem and opening message id", () => {
    createRoomWithOpeningMessage(
      db,
      "ABC123",
      "host-token-1",
      "Start here",
      "r_9wK3mQvH8",
    );

    const roomRow = db
      .prepare(
        `SELECT id, room_stem, opening_message_id, last_activity_at FROM rooms WHERE id = ?`,
      )
      .get("ABC123") as {
      id: string;
      room_stem: string;
      opening_message_id: number | null;
      last_activity_at: string | null;
    };

    expect(roomRow).toMatchObject({
      id: "ABC123",
      room_stem: "r_9wK3mQvH8",
      opening_message_id: expect.any(Number),
      last_activity_at: expect.any(String),
    });
  });

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

  test("createRoom persists the opening message atomically and links it from the room", () => {
    createRoomWithOpeningMessage(db, "ABC123", "host-token-1", "Opening hello");

    const roomRow = db
      .prepare(`SELECT id, opening_message_id FROM rooms WHERE id = ?`)
      .get("ABC123") as { id: string; opening_message_id: number | null };
    expect(roomRow.id).toBe("ABC123");
    expect(roomRow.opening_message_id).toEqual(expect.any(Number));

    const messages = db
      .prepare(`SELECT id, sender, content FROM messages WHERE room_id = ? ORDER BY id ASC`)
      .all("ABC123") as Array<{ id: number; sender: string; content: string }>;
    expect(messages).toEqual([
      {
        id: roomRow.opening_message_id!,
        sender: "host",
        content: "Opening hello",
      },
    ]);
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

describe("participant invites", () => {
  test("createInvite stores one host invite and one guest invite for the same room", () => {
    createRoom(db, "ABC123", "host-token-1");

    createInvite(db, "ABC123", "r_9wK3mQvH8.1");
    createInvite(db, "ABC123", "r_9wK3mQvH8.2");

    const rows = db
      .prepare(
        `SELECT participant_role, expires_at
         FROM invites
         WHERE room_id = ?
         ORDER BY participant_role ASC`,
      )
      .all("ABC123") as Array<{
      participant_role: string;
      expires_at: string;
    }>;

    expect(rows).toEqual([
      {
        participant_role: "guest",
        expires_at: expect.any(String),
      },
      {
        participant_role: "host",
        expires_at: expect.any(String),
      },
    ]);
  });

  test("claimInvite assigns the correct session token field by role", () => {
    createRoom(db, "ABC123", "host-token-1");
    createInvite(db, "ABC123", "r_9wK3mQvH8.1");
    createInvite(db, "ABC123", "r_9wK3mQvH8.2");

    const hostClaim = claimInvite(db, "r_9wK3mQvH8.1", "host-claim");
    const guestClaim = claimInvite(db, "r_9wK3mQvH8.2", "guest-claim");

    expect(hostClaim).toMatchObject({
      roomId: "ABC123",
      role: "host",
      sessionToken: expect.any(String),
      status: "waiting_for_both",
    });
    expect(guestClaim).toMatchObject({
      roomId: "ABC123",
      role: "guest",
      sessionToken: expect.any(String),
      status: "waiting_for_both",
    });

    expect(getRoom(db, "ABC123")).toMatchObject({
      host_token: hostClaim.sessionToken,
      guest_token: guestClaim.sessionToken,
    });
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

describe("postgres storage cutover prep", () => {
  test.if(inniesMigrationPaths.length > 0)("agentmeets storage migrations grant niyant access", () => {
    for (const migrationPath of inniesMigrationPaths) {
      const sql = readFileSync(migrationPath, "utf8");

      expect(sql).toContain("CREATE TABLE IF NOT EXISTS am_rooms");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS am_messages");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS am_invites");
      expect(sql).toContain("GRANT ALL PRIVILEGES ON TABLE am_rooms TO niyant;");
      expect(sql).toContain("GRANT ALL PRIVILEGES ON TABLE am_messages TO niyant;");
      expect(sql).toContain("GRANT ALL PRIVILEGES ON TABLE am_invites TO niyant;");
      expect(sql).toContain("GRANT ALL PRIVILEGES ON SEQUENCE am_messages_id_seq TO niyant;");
      expect(sql).toContain("GRANT ALL PRIVILEGES ON SEQUENCE am_invites_id_seq TO niyant;");
    }
  });

  test("async storage seam preserves opening message linkage", async () => {
    const { createFakeAgentMeetsStore } = await import("./fake-store.js");
    const store = createFakeAgentMeetsStore();

    const room = await store.createRoom({
      id: "ABC123",
      roomStem: "r_9wK3mQvH8",
      hostToken: "host-token-1",
      openingMessage: "Opening hello",
    });

    expect(room.opening_message_id).toEqual(expect.any(Number));

    const messages = await store.getMessages("ABC123");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      room_id: "ABC123",
      sender: "host",
      content: "Opening hello",
    });
  });
});

describe("postgres store bootstrap", () => {
  test("postgres bootstrap requires DATABASE_URL", async () => {
    const { readDatabaseUrl } = await import("./pg.js");
    expect(() => readDatabaseUrl({})).toThrow("DATABASE_URL");
  });

  test("postgres store exports a factory", async () => {
    const { createPostgresAgentMeetsStore } = await import("./pg-store.js");
    expect(typeof createPostgresAgentMeetsStore).toBe("function");
  });

  test("postgres joinRoom treats a concurrent guest claim as room full", async () => {
    const { createPostgresAgentMeetsStore } = await import("./pg-store.js");

    const fullRoom = createStoredRoomRow({
      guest_token: "guest-token-1",
      status: "active",
      joined_at: "2026-03-30T00:00:01.000Z",
      guest_connected_at: "2026-03-30T00:00:01.000Z",
    });

    const fakePool = {
      async query(text: string) {
        if (text.includes("SELECT *") && text.includes("FROM am_rooms")) {
          return {
            rowCount: 1,
            rows: [fullRoom],
          };
        }

        if (text.includes("UPDATE am_rooms")) {
          expect(text).toContain("guest_token IS NULL");
          expect(text).toContain("status = 'waiting'");
          return {
            rowCount: 0,
            rows: [],
          };
        }

        throw new Error(`Unexpected query: ${text}`);
      },
    };

    const store = createPostgresAgentMeetsStore({ pool: fakePool as any });
    await expect(store.joinRoom("ABC123", "guest-token-2")).rejects.toThrow("Room is full");
  });
});

function resolveInniesMigrationRoot(): string | null {
  const candidates = [
    process.env.INNIES_REPO_PATH?.trim(),
    path.resolve(import.meta.dir, "../../../../../../../innies"),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (existsSync(path.join(candidate, "docs/migrations"))) {
      return candidate;
    }
  }

  return null;
}

function createStoredRoomRow(
  overrides: Partial<StoredRoom> = {},
): StoredRoom {
  return {
    id: "ABC123",
    room_stem: "r_9wK3mQvH8",
    host_token: "host-token-1",
    guest_token: null,
    status: "waiting",
    opening_message_id: null,
    host_connected_at: "2026-03-30T00:00:00.000Z",
    guest_connected_at: null,
    created_at: "2026-03-30T00:00:00.000Z",
    last_activity_at: "2026-03-30T00:00:00.000Z",
    joined_at: null,
    closed_at: null,
    close_reason: null,
    ...overrides,
  };
}
