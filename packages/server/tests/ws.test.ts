import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { Room, Sender, StoredRoom, ServerMessage } from "@agentmeets/shared";
import { initializeSchema } from "../src/db/schema.js";
import { createRoom, joinRoom, closeRoom, getRoomByToken } from "../src/db/rooms.js";
import { RoomManager } from "../src/ws/room-manager.js";
import { createWebSocketHandlers } from "../src/ws/handler.js";
import { handleUpgrade } from "../src/ws/upgrade.js";
import type { WsData } from "../src/ws/room-manager.js";

function createTestDb(): Database {
  const db = new Database(":memory:");
  initializeSchema(db);
  return db;
}

const _publicRoomContractCheck = {
  id: "ROOM01",
  host_token: "host-token-123",
  guest_token: null,
  status: "waiting_for_join",
  created_at: "2026-03-24 00:00:00",
  joined_at: null,
  closed_at: null,
  close_reason: null,
} satisfies Room;

function setupRoom(db: Database): StoredRoom {
  const room = createRoom(db, "ROOM01", "host-token-123");
  return joinRoom(db, "ROOM01", "guest-token-456");
}

function waitForMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for message")), 5000);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(event.data as string));
      },
      { once: true },
    );
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for close")), 5000);
    ws.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout);
        resolve({ code: event.code, reason: event.reason });
      },
      { once: true },
    );
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for open")), 5000);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      (e) => {
        clearTimeout(timeout);
        reject(e);
      },
      { once: true },
    );
  });
}

function expectNoMessage(ws: WebSocket, durationMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = () => {
      clearTimeout(timeout);
      reject(new Error("Unexpected message"));
    };

    const timeout = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      resolve();
    }, durationMs);

    ws.addEventListener("message", onMessage, { once: true });
  });
}

describe("WebSocket relay — integration tests", () => {
  let server: ReturnType<typeof Bun.serve>;
  let db: Database;
  let roomManager: RoomManager;
  let port: number;

  beforeEach(() => {
    db = createTestDb();
    setupRoom(db);
    roomManager = new RoomManager(db);
    const wsHandlers = createWebSocketHandlers(roomManager);

    server = Bun.serve<WsData>({
      port: 0,
      fetch(req, srv) {
        const upgradeResp = handleUpgrade(req, srv, db, roomManager);
        if (upgradeResp) return upgradeResp;

        const url = new URL(req.url);
        if (url.pathname.match(/^\/rooms\/[^/]+\/ws$/)) {
          return undefined as unknown as Response;
        }
        return new Response("Not found", { status: 404 });
      },
      websocket: wsHandlers,
    });
    port = server.port;
  });

  afterEach(() => {
    roomManager.cleanupRoom("ROOM01");
    server.stop(true);
    db.close();
  });

  function connectAs(token: string, roomId = "ROOM01"): WebSocket {
    return new WebSocket(`ws://localhost:${port}/rooms/${roomId}/ws?token=${token}`);
  }

  test("rejects connection with missing token", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/rooms/ROOM01/ws`);
    const close = await waitForClose(ws);
    expect(close.code).not.toBe(1000);
  });

  test("rejects connection with invalid token", async () => {
    const ws = connectAs("bad-token");
    const close = await waitForClose(ws);
    expect(close.code).not.toBe(1000);
  });

  test("host connects successfully", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);
    expect(hostWs.readyState).toBe(WebSocket.OPEN);
    hostWs.close();
  });

  test("room_active is emitted only after both authenticated helpers connect", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);
    await expectNoMessage(hostWs);

    const hostActivationPromise = waitForMessage(hostWs);
    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);

    const hostActivation = await hostActivationPromise;
    expect(hostActivation).toEqual({ type: "room_active" });

    const guestActivation = await waitForMessage(guestWs);
    expect(guestActivation).toEqual({ type: "room_active" });

    hostWs.close();
    guestWs.close();
  });

  test("guest receives the persisted opening message replay after activation", async () => {
    const roomId = "ROOM02";
    createRoom(db, roomId, "host-token-789", "Welcome to the relay.");
    joinRoom(db, roomId, "guest-token-987");

    const hostWs = connectAs("host-token-789", roomId);
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-987", roomId);
    await waitForOpen(guestWs);

    expect(await waitForMessage(hostWs)).toEqual({ type: "room_active" });
    expect(await waitForMessage(guestWs)).toEqual({ type: "room_active" });

    const replay = (await waitForMessage(guestWs)) as Record<string, unknown>;
    expect(replay).toMatchObject({
      type: "message",
      sender: "host",
      replyToMessageId: null,
      content: "Welcome to the relay.",
    });
    expect(replay.clientMessageId).toBe(`persisted:${replay.messageId}`);
    expect(typeof replay.messageId).toBe("number");
    expect(typeof replay.createdAt).toBe("string");

    roomManager.cleanupRoom(roomId);
    hostWs.close();
    guestWs.close();
  });

  test("sender receives ack and receiver gets enriched message", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'room_active'
    await waitForMessage(guestWs); // consume 'room_active'

    const ackPromise = waitForMessage(hostWs);
    const msgPromise = waitForMessage(guestWs);
    hostWs.send(
      JSON.stringify({
        type: "message",
        clientMessageId: "host-msg-1",
        replyToMessageId: null,
        content: "hello guest",
      }),
    );

    const ack = (await ackPromise) as unknown as Record<string, unknown>;
    expect(ack).toMatchObject({
      type: "ack",
      clientMessageId: "host-msg-1",
      replyToMessageId: null,
    });
    expect(typeof ack.messageId).toBe("number");
    expect(typeof ack.createdAt).toBe("string");

    const msg = (await msgPromise) as unknown as Record<string, unknown>;
    expect(msg).toMatchObject({
      type: "message",
      sender: "host",
      clientMessageId: "host-msg-1",
      replyToMessageId: null,
      content: "hello guest",
    });
    expect(typeof msg.messageId).toBe("number");
    expect(typeof msg.createdAt).toBe("string");

    // Verify message was persisted in DB
    const messages = db
      .prepare("SELECT * FROM messages WHERE room_id = ?")
      .all("ROOM01") as Array<{ sender: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe("host");
    expect(messages[0].content).toBe("hello guest");

    hostWs.close();
    guestWs.close();
  });

  test("messages relay from guest to host", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'room_active'
    await waitForMessage(guestWs); // consume 'room_active'

    const ackPromise = waitForMessage(guestWs);
    const msgPromise = waitForMessage(hostWs);
    guestWs.send(
      JSON.stringify({
        type: "message",
        clientMessageId: "guest-msg-1",
        replyToMessageId: 1,
        content: "hello host",
      }),
    );

    const ack = (await ackPromise) as unknown as Record<string, unknown>;
    expect(ack).toMatchObject({
      type: "ack",
      clientMessageId: "guest-msg-1",
      replyToMessageId: 1,
    });
    expect(typeof ack.messageId).toBe("number");
    expect(typeof ack.createdAt).toBe("string");

    const msg = (await msgPromise) as unknown as Record<string, unknown>;
    expect(msg).toMatchObject({
      type: "message",
      sender: "guest",
      clientMessageId: "guest-msg-1",
      replyToMessageId: 1,
      content: "hello host",
    });
    expect(typeof msg.messageId).toBe("number");
    expect(typeof msg.createdAt).toBe("string");

    hostWs.close();
    guestWs.close();
  });

  test("missing replyToMessageId returns error event", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const errorPromise = waitForMessage(hostWs);
    hostWs.send(
      JSON.stringify({
        type: "message",
        clientMessageId: "missing-reply-id",
        content: "missing replyToMessageId",
      }),
    );

    const msg = (await errorPromise) as unknown as Record<string, unknown>;
    expect(msg).toMatchObject({
      type: "error",
      code: "invalid_message",
    });
    expect(msg.message).toBe(
      "Invalid message: replyToMessageId must be present and be an integer or null",
    );

    hostWs.close();
  });

  test("end from host notifies guest", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'room_active'
    await waitForMessage(guestWs); // consume 'room_active'

    const senderEndedPromise = waitForMessage(hostWs);
    const endedPromise = waitForMessage(guestWs);
    hostWs.send(JSON.stringify({ type: "end" }));
    const senderMsg = await senderEndedPromise;
    const msg = await endedPromise;
    expect(senderMsg).toEqual({ type: "ended", reason: "user_ended" });
    expect(msg).toEqual({ type: "ended", reason: "user_ended" });

    // Verify room was closed in DB
    const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get("ROOM01") as StoredRoom;
    expect(room.status).toBe("closed");
    expect(room.close_reason).toBe("user_ended");
  });

  test("end from guest notifies host", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'room_active'
    await waitForMessage(guestWs); // consume 'room_active'

    const senderEndedPromise = waitForMessage(guestWs);
    const endedPromise = waitForMessage(hostWs);
    guestWs.send(JSON.stringify({ type: "end" }));
    const senderMsg = await senderEndedPromise;
    const msg = await endedPromise;
    expect(senderMsg).toEqual({ type: "ended", reason: "user_ended" });
    expect(msg).toEqual({ type: "ended", reason: "user_ended" });
  });

  test("activation timeout closes the relay with join_failed", async () => {
    const db = createTestDb();
    setupRoom(db);
    const roomManager = new RoomManager(db, { joinTimeoutMs: 50 });
    const wsHandlers = createWebSocketHandlers(roomManager);

    const server = Bun.serve<WsData>({
      port: 0,
      fetch(req, srv) {
        const upgradeResp = handleUpgrade(req, srv, db, roomManager);
        if (upgradeResp) return upgradeResp;
        const url = new URL(req.url);
        if (url.pathname.match(/^\/rooms\/[^/]+\/ws$/)) {
          return undefined as unknown as Response;
        }
        return new Response("Not found", { status: 404 });
      },
      websocket: wsHandlers,
    });

    try {
      const guestWs = new WebSocket(
        `ws://localhost:${server.port}/rooms/ROOM01/ws?token=guest-token-456`,
      );
      await waitForOpen(guestWs);
      const ended = await waitForMessage(guestWs);
      expect(ended).toEqual({ type: "ended", reason: "join_failed" });
      const close = await waitForClose(guestWs);
      expect(close.reason).toBe("join_failed");

      const room = db.prepare("SELECT status, close_reason FROM rooms WHERE id = ?").get("ROOM01") as {
        status: StoredRoom["status"];
        close_reason: StoredRoom["close_reason"];
      };
      expect(room.status).toBe("closed");
      expect(room.close_reason).toBe("join_failed");
    } finally {
      roomManager.cleanupRoom("ROOM01");
      server.stop(true);
      db.close();
    }
  });

  test("host disconnect closes the active guest with reason disconnected", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'room_active'
    await waitForMessage(guestWs); // consume 'room_active'

    const endedPromise = waitForMessage(guestWs);
    const closePromise = waitForClose(guestWs);
    hostWs.close();
    const ended = await endedPromise;
    expect(ended).toEqual({ type: "ended", reason: "disconnected" });
    const close = await closePromise;
    expect(close.reason).toBe("disconnected");

    const room = db.prepare("SELECT status, close_reason FROM rooms WHERE id = ?").get("ROOM01") as StoredRoom;
    expect(room.status).toBe("closed");
    expect(room.close_reason).toBe("disconnected");
  });

  test("guest disconnect closes the active host with reason disconnected", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'room_active'
    await waitForMessage(guestWs); // consume 'room_active'

    const endedPromise = waitForMessage(hostWs);
    const closePromise = waitForClose(hostWs);
    guestWs.close();
    const ended = await endedPromise;
    expect(ended).toEqual({ type: "ended", reason: "disconnected" });
    const close = await closePromise;
    expect(close.reason).toBe("disconnected");

    const room = db.prepare("SELECT status, close_reason FROM rooms WHERE id = ?").get("ROOM01") as StoredRoom;
    expect(room.status).toBe("closed");
    expect(room.close_reason).toBe("disconnected");
  });

  test("message size limit is enforced", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'room_active'
    await waitForMessage(guestWs); // consume 'room_active'

    const closePromise = waitForClose(hostWs);
    const bigContent = "x".repeat(100 * 1024 + 1);
    hostWs.send(
      JSON.stringify({
        type: "message",
        clientMessageId: "too-big-1",
        replyToMessageId: null,
        content: bigContent,
      }),
    );
    const close = await closePromise;
    expect(close.code).toBe(1009);

    guestWs.close();
  });

  test("message size limit enforced by byte length, not character count", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'room_active'
    await waitForMessage(guestWs); // consume 'room_active'

    // Each emoji (e.g. 🎉) is 4 bytes in UTF-8 but 2 UTF-16 code units.
    // 25601 emoji × 4 bytes = 102404 bytes > 100KB, but only 51202 UTF-16 code units.
    const closePromise = waitForClose(hostWs);
    const emoji = "🎉";
    const count = Math.ceil((100 * 1024 + 1) / Buffer.byteLength(emoji, "utf8"));
    const bigContent = emoji.repeat(count);
    expect(bigContent.length).toBeLessThan(100 * 1024); // under limit by character count
    expect(Buffer.byteLength(bigContent, "utf8")).toBeGreaterThan(100 * 1024); // over limit by byte length
    hostWs.send(
      JSON.stringify({
        type: "message",
        clientMessageId: "too-big-emoji-1",
        replyToMessageId: null,
        content: bigContent,
      }),
    );
    const close = await closePromise;
    expect(close.code).toBe(1009);

    guestWs.close();
  });

  test("rejects duplicate connection for same role", async () => {
    const hostWs1 = connectAs("host-token-123");
    await waitForOpen(hostWs1);

    // Second connection with the same host token should be rejected (409)
    const hostWs2 = connectAs("host-token-123");
    const close = await waitForClose(hostWs2);
    expect(close.code).not.toBe(1000);

    // Original connection should still be open
    expect(hostWs1.readyState).toBe(WebSocket.OPEN);

    hostWs1.close();
  });

  test("rejects connection to closed room", async () => {
    closeRoom(db, "ROOM01", "closed");

    const ws = connectAs("host-token-123");
    const close = await waitForClose(ws);
    expect(close.code).not.toBe(1000);
  });
});

describe("RoomManager timeouts", () => {
  test("join timeout exists after host connects", async () => {
    const db = createTestDb();
    setupRoom(db);
    const roomManager = new RoomManager(db);
    const wsHandlers = createWebSocketHandlers(roomManager);

    const server = Bun.serve<WsData>({
      port: 0,
      fetch(req, srv) {
        const upgradeResp = handleUpgrade(req, srv, db, roomManager);
        if (upgradeResp) return upgradeResp;
        const url = new URL(req.url);
        if (url.pathname.match(/^\/rooms\/[^/]+\/ws$/)) {
          return undefined as unknown as Response;
        }
        return new Response("Not found", { status: 404 });
      },
      websocket: wsHandlers,
    });

    try {
      const hostWs = new WebSocket(
        `ws://localhost:${server.port}/rooms/ROOM01/ws?token=host-token-123`,
      );
      await waitForOpen(hostWs);
      expect(roomManager.hasRoom("ROOM01")).toBe(true);
      hostWs.close();
    } finally {
      roomManager.cleanupRoom("ROOM01");
      server.stop(true);
      db.close();
    }
  });

  test("idle timeout is reset on message exchange", async () => {
    const db = createTestDb();
    setupRoom(db);
    const roomManager = new RoomManager(db);
    const wsHandlers = createWebSocketHandlers(roomManager);

    const server = Bun.serve<WsData>({
      port: 0,
      fetch(req, srv) {
        const upgradeResp = handleUpgrade(req, srv, db, roomManager);
        if (upgradeResp) return upgradeResp;
        const url = new URL(req.url);
        if (url.pathname.match(/^\/rooms\/[^/]+\/ws$/)) {
          return undefined as unknown as Response;
        }
        return new Response("Not found", { status: 404 });
      },
      websocket: wsHandlers,
    });

    try {
      const hostWs = new WebSocket(
        `ws://localhost:${server.port}/rooms/ROOM01/ws?token=host-token-123`,
      );
      await waitForOpen(hostWs);

      const guestWs = new WebSocket(
        `ws://localhost:${server.port}/rooms/ROOM01/ws?token=guest-token-456`,
      );
      await waitForOpen(guestWs);
      await waitForMessage(hostWs); // consume 'room_active'
      await waitForMessage(guestWs); // consume 'room_active'

      const msgPromise = waitForMessage(guestWs);
      const ackPromise = waitForMessage(hostWs);
      hostWs.send(
        JSON.stringify({
          type: "message",
          clientMessageId: "ping-1",
          replyToMessageId: null,
          content: "ping",
        }),
      );
      await ackPromise;
      const msg = await msgPromise;
      expect(msg).toMatchObject({
        type: "message",
        sender: "host",
        clientMessageId: "ping-1",
        replyToMessageId: null,
        content: "ping",
      });

      expect(roomManager.hasRoom("ROOM01")).toBe(true);

      hostWs.close();
      guestWs.close();
    } finally {
      roomManager.cleanupRoom("ROOM01");
      server.stop(true);
      db.close();
    }
  });

  test("idle timeout expires an active room with reason expired", async () => {
    const db = createTestDb();
    setupRoom(db);
    const roomManager = new RoomManager(db, { idleTimeoutMs: 50 });
    const wsHandlers = createWebSocketHandlers(roomManager);

    const server = Bun.serve<WsData>({
      port: 0,
      fetch(req, srv) {
        const upgradeResp = handleUpgrade(req, srv, db, roomManager);
        if (upgradeResp) return upgradeResp;
        const url = new URL(req.url);
        if (url.pathname.match(/^\/rooms\/[^/]+\/ws$/)) {
          return undefined as unknown as Response;
        }
        return new Response("Not found", { status: 404 });
      },
      websocket: wsHandlers,
    });

    try {
      const hostWs = new WebSocket(
        `ws://localhost:${server.port}/rooms/ROOM01/ws?token=host-token-123`,
      );
      await waitForOpen(hostWs);

      const guestWs = new WebSocket(
        `ws://localhost:${server.port}/rooms/ROOM01/ws?token=guest-token-456`,
      );
      await waitForOpen(guestWs);
      await waitForMessage(hostWs); // consume 'room_active'
      await waitForMessage(guestWs); // consume 'room_active'

      expect(await waitForMessage(hostWs)).toEqual({ type: "ended", reason: "expired" });
      expect(await waitForMessage(guestWs)).toEqual({ type: "ended", reason: "expired" });

      const room = db.prepare("SELECT status, closed_at, close_reason FROM rooms WHERE id = ?").get(
        "ROOM01",
      ) as {
        status: StoredRoom["status"];
        closed_at: string | null;
        close_reason: StoredRoom["close_reason"];
      };
      expect(room.status).toBe("expired");
      expect(room.closed_at).toEqual(expect.any(String));
      expect(room.close_reason).toBeNull();
    } finally {
      roomManager.cleanupRoom("ROOM01");
      server.stop(true);
      db.close();
    }
  });
});

describe("handleUpgrade — token validation", () => {
  test("rejects when token does not match room ID", () => {
    const db = createTestDb();
    createRoom(db, "ROOM01", "host-token-123");
    joinRoom(db, "ROOM01", "guest-token-456");
    createRoom(db, "ROOM02", "other-host");
    joinRoom(db, "ROOM02", "other-guest");
    const roomManager = new RoomManager(db);

    const mockServer = { upgrade: () => true } as any;

    const req = new Request("http://localhost/rooms/ROOM02/ws?token=host-token-123");
    const result = handleUpgrade(req, mockServer, db, roomManager);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);

    db.close();
  });

  test("rejects expired room", () => {
    const db = createTestDb();
    createRoom(db, "ROOM01", "host-token-123");
    // Manually set status to expired
    db.prepare("UPDATE rooms SET status = 'expired', closed_at = datetime('now') WHERE id = ?").run(
      "ROOM01",
    );
    const roomManager = new RoomManager(db);

    const mockServer = { upgrade: () => true } as any;
    const req = new Request("http://localhost/rooms/ROOM01/ws?token=host-token-123");
    const result = handleUpgrade(req, mockServer, db, roomManager);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(410);

    db.close();
  });
});
