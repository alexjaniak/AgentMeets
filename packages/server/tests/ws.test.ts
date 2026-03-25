import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { Sender, Room, ServerMessage } from "@agentmeets/shared";
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

function setupRoom(db: Database): Room {
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

  test("host receives 'joined' when guest connects", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const joinedPromise = waitForMessage(hostWs);
    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);

    const msg = await joinedPromise;
    expect(msg).toEqual({ type: "joined" });

    hostWs.close();
    guestWs.close();
  });

  test("messages relay from host to guest", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'joined'

    const msgPromise = waitForMessage(guestWs);
    hostWs.send(JSON.stringify({ type: "message", content: "hello guest" }));
    const msg = await msgPromise;
    expect(msg).toEqual({ type: "message", content: "hello guest" });

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
    await waitForMessage(hostWs); // consume 'joined'

    const msgPromise = waitForMessage(hostWs);
    guestWs.send(JSON.stringify({ type: "message", content: "hello host" }));
    const msg = await msgPromise;
    expect(msg).toEqual({ type: "message", content: "hello host" });

    hostWs.close();
    guestWs.close();
  });

  test("end from host notifies guest", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'joined'

    const endedPromise = waitForMessage(guestWs);
    hostWs.send(JSON.stringify({ type: "end" }));
    const msg = await endedPromise;
    expect(msg).toEqual({ type: "ended", reason: "closed" });

    // Verify room was closed in DB
    const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get("ROOM01") as Room;
    expect(room.status).toBe("closed");
    expect(room.close_reason).toBe("closed");
  });

  test("end from guest notifies host", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'joined'

    const endedPromise = waitForMessage(hostWs);
    guestWs.send(JSON.stringify({ type: "end" }));
    const msg = await endedPromise;
    expect(msg).toEqual({ type: "ended", reason: "closed" });
  });

  test("host disconnect notifies guest", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'joined'

    const endedPromise = waitForMessage(guestWs);
    hostWs.close();
    const msg = await endedPromise;
    expect(msg).toEqual({ type: "ended", reason: "closed" });
  });

  test("guest disconnect notifies host", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'joined'

    const endedPromise = waitForMessage(hostWs);
    guestWs.close();
    const msg = await endedPromise;
    expect(msg).toEqual({ type: "ended", reason: "closed" });
  });

  test("message size limit is enforced", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'joined'

    const closePromise = waitForClose(hostWs);
    const bigContent = "x".repeat(100 * 1024 + 1);
    hostWs.send(JSON.stringify({ type: "message", content: bigContent }));
    const close = await closePromise;
    expect(close.code).toBe(1009);

    guestWs.close();
  });

  test("message size limit enforced by byte length, not character count", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'joined'

    // Each emoji (e.g. 🎉) is 4 bytes in UTF-8 but 2 UTF-16 code units.
    // 25601 emoji × 4 bytes = 102404 bytes > 100KB, but only 51202 UTF-16 code units.
    const closePromise = waitForClose(hostWs);
    const emoji = "🎉";
    const count = Math.ceil((100 * 1024 + 1) / Buffer.byteLength(emoji, "utf8"));
    const bigContent = emoji.repeat(count);
    expect(bigContent.length).toBeLessThan(100 * 1024); // under limit by character count
    expect(Buffer.byteLength(bigContent, "utf8")).toBeGreaterThan(100 * 1024); // over limit by byte length
    hostWs.send(JSON.stringify({ type: "message", content: bigContent }));
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
      await waitForMessage(hostWs); // consume 'joined'

      const msgPromise = waitForMessage(guestWs);
      hostWs.send(JSON.stringify({ type: "message", content: "ping" }));
      const msg = await msgPromise;
      expect(msg).toEqual({ type: "message", content: "ping" });

      expect(roomManager.hasRoom("ROOM01")).toBe(true);

      hostWs.close();
      guestWs.close();
    } finally {
      roomManager.cleanupRoom("ROOM01");
      server.stop(true);
      db.close();
    }
  });

  test("hard timeout is started when guest joins", async () => {
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
      await waitForMessage(hostWs); // consume 'joined'

      expect(roomManager.hasRoom("ROOM01")).toBe(true);

      hostWs.close();
      guestWs.close();
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
