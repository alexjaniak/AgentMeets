import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import type { Room, Sender, StoredRoom, ServerMessage } from "@agentmeets/shared";
import { initializeSchema } from "../src/db/schema.js";
import { createRoom, joinRoom, closeRoom, getRoomByToken } from "../src/db/rooms.js";
import { claimInvite, createInvite } from "../src/db/invites.js";
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

function waitForMessages(ws: WebSocket, count: number): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: ServerMessage[] = [];
    const timeout = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("Timeout waiting for messages"));
    }, 5000);

    const onMessage = (event: MessageEvent) => {
      messages.push(JSON.parse(event.data as string) as ServerMessage);
      if (messages.length === count) {
        clearTimeout(timeout);
        ws.removeEventListener("message", onMessage);
        resolve(messages);
      }
    };

    ws.addEventListener("message", onMessage);
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

function createFakeServerSocket() {
  const sent: ServerMessage[] = [];
  const closed: Array<{ code: number; reason: string }> = [];

  const ws = {
    send(payload: string) {
      sent.push(JSON.parse(payload) as ServerMessage);
    },
    close(code: number, reason: string) {
      closed.push({ code, reason });
    },
  } as unknown as import("bun").ServerWebSocket<WsData>;

  return { ws, sent, closed };
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

  test("guest receives all persisted host messages that were accepted before activation", async () => {
    const roomId = "ROOM03";
    createRoom(db, roomId, "host-token-790", "Opening context.");
    db.prepare("UPDATE rooms SET guest_token = ? WHERE id = ?").run(
      "guest-token-988",
      roomId,
    );

    const hostWs = connectAs("host-token-790", roomId);
    await waitForOpen(hostWs);

    const hostAckPromise = waitForMessage(hostWs);
    hostWs.send(
      JSON.stringify({
        type: "message",
        clientMessageId: "prejoin-host-1",
        replyToMessageId: null,
        content: "Additional context before you join.",
      }),
    );

    expect(await hostAckPromise).toMatchObject({
      type: "ack",
      clientMessageId: "prejoin-host-1",
    });

    const guestWs = connectAs("guest-token-988", roomId);
    await waitForOpen(guestWs);

    expect(await waitForMessage(hostWs)).toEqual({ type: "room_active" });
    expect(await waitForMessage(guestWs)).toEqual({ type: "room_active" });

    expect(await waitForMessage(guestWs)).toMatchObject({
      type: "message",
      sender: "host",
      content: "Opening context.",
    });
    expect(await waitForMessage(guestWs)).toMatchObject({
      type: "message",
      sender: "host",
      content: "Additional context before you join.",
    });

    roomManager.cleanupRoom(roomId);
    hostWs.close();
    guestWs.close();
  });

  test("host receives guest messages that were accepted before activation when guest connects first", async () => {
    const roomId = "ROOM04";
    createRoom(db, roomId, "host-token-791", "Opening context.");
    db.prepare("UPDATE rooms SET guest_token = ? WHERE id = ?").run(
      "guest-token-989",
      roomId,
    );

    const guestWs = connectAs("guest-token-989", roomId);
    await waitForOpen(guestWs);

    const guestAckPromise = waitForMessage(guestWs);
    guestWs.send(
      JSON.stringify({
        type: "message",
        clientMessageId: "prejoin-guest-1",
        replyToMessageId: null,
        content: "Guest context before the host arrives.",
      }),
    );

    expect(await guestAckPromise).toMatchObject({
      type: "ack",
      clientMessageId: "prejoin-guest-1",
    });

    const guestMessagesPromise = waitForMessages(guestWs, 2);
    const hostWs = connectAs("host-token-791", roomId);
    const hostMessagesPromise = waitForMessages(hostWs, 2);
    await waitForOpen(hostWs);

    const [hostMessages, guestMessages] = await Promise.all([
      hostMessagesPromise,
      guestMessagesPromise,
    ]);
    expect(hostMessages[0]).toEqual({ type: "room_active" });
    expect(hostMessages[1]).toMatchObject({
      type: "message",
      sender: "guest",
      content: "Guest context before the host arrives.",
    });
    expect(guestMessages[0]).toEqual({ type: "room_active" });
    expect(guestMessages[1]).toMatchObject({
      type: "message",
      sender: "host",
      content: "Opening context.",
    });

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

  test("waiting rooms expire with reason expired when their invite TTL elapses", async () => {
    const db = createTestDb();
    createRoom(db, "WAIT01", "host-token-waiting", "Opening context", "r_waiting");
    createInvite(
      db,
      "WAIT01",
      "r_waiting.1",
      new Date(Date.now() + 50).toISOString(),
    );
    createInvite(
      db,
      "WAIT01",
      "r_waiting.2",
      new Date(Date.now() + 50).toISOString(),
    );
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
        `ws://localhost:${server.port}/rooms/WAIT01/ws?token=host-token-waiting`,
      );
      await waitForOpen(hostWs);
      const ended = await waitForMessage(hostWs);
      expect(ended).toEqual({ type: "ended", reason: "expired" });
      const close = await waitForClose(hostWs);
      expect(close.reason).toBe("Room expired");

      const room = db.prepare("SELECT status, close_reason FROM rooms WHERE id = ?").get("WAIT01") as {
        status: StoredRoom["status"];
        close_reason: StoredRoom["close_reason"];
      };
      expect(room.status).toBe("expired");
      expect(room.close_reason).toBeNull();
    } finally {
      roomManager.cleanupRoom("WAIT01");
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
  test("waiting rooms are tracked after the first helper connects", async () => {
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

  test("legacy joined rooms use idle expiry even before the second socket connects", async () => {
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

      expect(await waitForMessage(hostWs)).toEqual({ type: "ended", reason: "expired" });

      const room = db.prepare("SELECT status FROM rooms WHERE id = ?").get("ROOM01") as {
        status: StoredRoom["status"];
      };
      expect(room.status).toBe("expired");
    } finally {
      roomManager.cleanupRoom("ROOM01");
      server.stop(true);
      db.close();
    }
  });

  test("pre-join messages do not start idle expiry before activation", async () => {
    const db = createTestDb();
    createRoom(db, "WAIT10", "host-token-wait10", "Opening context", "r_wait10");
    createInvite(
      db,
      "WAIT10",
      "r_wait10.1",
      new Date(Date.now() + 200).toISOString(),
    );
    createInvite(
      db,
      "WAIT10",
      "r_wait10.2",
      new Date(Date.now() + 200).toISOString(),
    );

    const roomManager = new RoomManager(db, { idleTimeoutMs: 50 });
    const host = createFakeServerSocket();

    roomManager.addConnection("WAIT10", "host", host.ws);
    const accepted = roomManager.handleMessage("WAIT10", "host", {
      clientMessageId: "prejoin-1",
      replyToMessageId: null,
      content: "still waiting",
    });

    expect(accepted).toBe(true);
    expect(host.sent[0]).toMatchObject({
      type: "ack",
      clientMessageId: "prejoin-1",
    });

    await Bun.sleep(100);

    expect(host.sent).toHaveLength(1);
    expect(host.closed).toHaveLength(0);

    const room = db.prepare("SELECT status FROM rooms WHERE id = ?").get("WAIT10") as {
      status: StoredRoom["status"];
    };
    expect(room.status).toBe("waiting");

    roomManager.cleanupRoom("WAIT10");
    db.close();
  });

  test("claimed waiting rooms still expire after the only helper disconnects", async () => {
    const db = createTestDb();
    createRoom(db, "WAIT12", "host-token-wait12", "Opening context", "r_wait12");
    createInvite(
      db,
      "WAIT12",
      "r_wait12.1",
      new Date(Date.now() + 5_000).toISOString(),
    );
    createInvite(
      db,
      "WAIT12",
      "r_wait12.2",
      new Date(Date.now() + 5_000).toISOString(),
    );
    const hostClaim = claimInvite(db, "r_wait12.1", "wait12-host-claim");

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
        `ws://localhost:${server.port}/rooms/WAIT12/ws?token=${hostClaim.sessionToken}`,
      );
      await waitForOpen(hostWs);
      hostWs.close();
      await Bun.sleep(100);

      const room = db.prepare("SELECT status, closed_at FROM rooms WHERE id = ?").get("WAIT12") as {
        status: StoredRoom["status"];
        closed_at: string | null;
      };
      expect(room.status).toBe("expired");
      expect(room.closed_at).toEqual(expect.any(String));
    } finally {
      roomManager.cleanupRoom("WAIT12");
      server.stop(true);
      db.close();
    }
  });

  test("expired waiting rooms do not activate even if both sockets connect", () => {
    const db = createTestDb();
    createRoom(db, "WAIT11", "host-token-wait11", "Opening context", "r_wait11");
    db.prepare("UPDATE rooms SET guest_token = ? WHERE id = ?").run(
      "guest-token-wait11",
      "WAIT11",
    );
    createInvite(
      db,
      "WAIT11",
      "r_wait11.1",
      new Date(Date.now() - 1_000).toISOString(),
    );
    createInvite(
      db,
      "WAIT11",
      "r_wait11.2",
      new Date(Date.now() - 1_000).toISOString(),
    );

    const roomManager = new RoomManager(db);
    const host = createFakeServerSocket();
    const guest = createFakeServerSocket();

    roomManager.addConnection("WAIT11", "host", host.ws);
    roomManager.addConnection("WAIT11", "guest", guest.ws);

    expect(host.sent).toEqual([{ type: "ended", reason: "expired" }]);
    expect(guest.sent).toEqual([{ type: "ended", reason: "expired" }]);
    expect(host.closed).toEqual([{ code: 1000, reason: "Room expired" }]);
    expect(guest.closed).toEqual([{ code: 1000, reason: "Room expired" }]);

    const room = db.prepare("SELECT status FROM rooms WHERE id = ?").get("WAIT11") as {
      status: StoredRoom["status"];
    };
    expect(room.status).toBe("expired");

    db.close();
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
