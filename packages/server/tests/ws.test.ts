import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Room, Sender, StoredRoom, ServerMessage } from "@agentmeets/shared";
import {
  createFakeAgentMeetsStore,
  type AgentMeetsStore,
} from "../src/db/index.js";
import { RoomManager } from "../src/ws/room-manager.js";
import { createWebSocketHandlers } from "../src/ws/handler.js";
import { handleUpgrade } from "../src/ws/upgrade.js";
import type { WsData } from "../src/ws/room-manager.js";

function createTestStore(): AgentMeetsStore {
  return createFakeAgentMeetsStore();
}

const _publicRoomContractCheck = {
  id: "ROOM01",
  room_stem: null,
  host_token: "host-token-123",
  guest_token: null,
  status: "waiting_for_both",
  host_connected_at: null,
  guest_connected_at: null,
  created_at: "2026-03-24 00:00:00",
  joined_at: null,
  closed_at: null,
  close_reason: null,
} satisfies Room;

async function setupRoom(store: AgentMeetsStore): Promise<StoredRoom> {
  await store.createRoom({ id: "ROOM01", hostToken: "host-token-123" });
  return store.joinRoom("ROOM01", "guest-token-456");
}

function roomActive(roomId: string) {
  return { type: "room_active", roomId } as const;
}

function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for message")), timeoutMs);
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
  let store: AgentMeetsStore;
  let roomManager: RoomManager;
  let port: number;

  beforeEach(async () => {
    store = createTestStore();
    await setupRoom(store);
    roomManager = new RoomManager(store);
    const wsHandlers = createWebSocketHandlers(roomManager);

    server = Bun.serve<WsData>({
      port: 0,
      async fetch(req, srv) {
        const upgradeResp = await handleUpgrade(req, srv, store, roomManager);
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
    expect(hostActivation).toEqual(roomActive("ROOM01"));

    const guestActivation = await waitForMessage(guestWs);
    expect(guestActivation).toEqual(roomActive("ROOM01"));

    hostWs.close();
    guestWs.close();
  });

  test("guest receives the persisted opening message immediately before activation", async () => {
    const roomId = "ROOM02";
    await store.createRoom({
      id: roomId,
      hostToken: "host-token-789",
      openingMessage: "Welcome to the relay.",
      roomStem: "r_room02",
    });
    await store.createInvite(roomId, "r_room02.1", "2099-03-24T12:05:00.000Z");
    await store.createInvite(roomId, "r_room02.2", "2099-03-24T12:05:00.000Z");
    const guestClaim = await store.claimInvite("r_room02.2", "room02-guest-claim");
    const guestWs = connectAs(guestClaim.sessionToken, roomId);
    await waitForOpen(guestWs);

    const replay = (await waitForMessage(guestWs, 250)) as Record<string, unknown>;
    expect(replay).toMatchObject({
      type: "message",
      sender: "host",
      replyToMessageId: null,
      content: "Welcome to the relay.",
    });
    expect(replay.clientMessageId).toBe(`persisted:${replay.messageId}`);
    expect(typeof replay.messageId).toBe("number");
    expect(typeof replay.createdAt).toBe("string");
    await expectNoMessage(guestWs);

    roomManager.cleanupRoom(roomId);
    guestWs.close();
  });

  test("guest receives all persisted host messages that were accepted before activation", async () => {
    const roomId = "ROOM03";
    await store.createRoom({
      id: roomId,
      hostToken: "host-token-790",
      openingMessage: "Opening context.",
      roomStem: "r_room03",
    });
    await store.createInvite(roomId, "r_room03.1", "2099-03-24T12:05:00.000Z");
    await store.createInvite(roomId, "r_room03.2", "2099-03-24T12:05:00.000Z");
    const guestClaim = await store.claimInvite("r_room03.2", "room03-guest-claim");

    const hostWs = connectAs("host-token-790", roomId);
    await waitForOpen(hostWs);

    // Host no longer receives its own opening message on replay
    await expectNoMessage(hostWs);

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

    const hostActivationPromise = waitForMessage(hostWs);
    const guestWs = connectAs(guestClaim.sessionToken, roomId);
    const guestMessagesPromise = waitForMessages(guestWs, 3);
    await waitForOpen(guestWs);

    const guestMessages = await guestMessagesPromise;
    expect(guestMessages[0]).toMatchObject({
      type: "message",
      sender: "host",
      content: "Opening context.",
    });
    expect(guestMessages[1]).toMatchObject({
      type: "message",
      sender: "host",
      content: "Additional context before you join.",
    });
    expect(guestMessages[2]).toEqual(roomActive(roomId));
    expect(await hostActivationPromise).toEqual(roomActive(roomId));

    roomManager.cleanupRoom(roomId);
    hostWs.close();
    guestWs.close();
  });

  test("host replays the opening message first when guest drafts before host attach", async () => {
    const roomId = "ROOM04";
    await store.createRoom({
      id: roomId,
      hostToken: "host-token-791",
      openingMessage: "Opening message from the room creator.",
      roomStem: "r_room04",
    });
    await store.createInvite(roomId, "r_room04.1", "2099-03-24T12:05:00.000Z");
    await store.createInvite(roomId, "r_room04.2", "2099-03-24T12:05:00.000Z");
    const guestClaim = await store.claimInvite("r_room04.2", "room04-guest-claim");

    const guestWs = connectAs(guestClaim.sessionToken, roomId);
    await waitForOpen(guestWs);

    const openingReplay = (await waitForMessage(guestWs, 250)) as Record<string, unknown>;
    expect(openingReplay).toMatchObject({
      type: "message",
      sender: "host",
      content: "Opening message from the room creator.",
    });

    const guestAckPromise = waitForMessage(guestWs);
    guestWs.send(
      JSON.stringify({
        type: "message",
        clientMessageId: "prejoin-guest-1",
        replyToMessageId: openingReplay.messageId as number,
        content: "Guest reply drafted before host attach.",
      }),
    );

    expect(await guestAckPromise).toMatchObject({
      type: "ack",
      clientMessageId: "prejoin-guest-1",
    });

    await expectNoMessage(guestWs);

    const guestActivationPromise = waitForMessage(guestWs);
    const hostWs = connectAs("host-token-791", roomId);
    // Host gets: guest reply replay + room_active (no own opening message replay)
    const hostMessagesPromise = waitForMessages(hostWs, 2);
    await waitForOpen(hostWs);

    const [hostMessages, guestActivation] = await Promise.all([
      hostMessagesPromise,
      guestActivationPromise,
    ]);
    expect(guestActivation).toEqual(roomActive(roomId));

    const replayedToHost = hostMessages
      .filter((message) => (message as Record<string, unknown>).type === "message")
      .map((message) => (message as Record<string, unknown>).content);
    expect(replayedToHost).toEqual([
      "Guest reply drafted before host attach.",
    ]);
    expect(hostMessages.find((m) => (m as Record<string, unknown>).type === "room_active")).toEqual(roomActive(roomId));

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
    const messages = await store.getMessages("ROOM01");
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
    const room = await store.getRoom("ROOM01");
    expect(room).not.toBeNull();
    expect(room!.status).toBe("closed");
    expect(room!.close_reason).toBe("user_ended");
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
    const store = createTestStore();
    await store.createRoom({
      id: "WAIT01",
      hostToken: "host-token-waiting",
      openingMessage: "Opening context",
      roomStem: "r_waiting",
    });
    await store.createInvite(
      "WAIT01",
      "r_waiting.1",
      new Date(Date.now() + 50).toISOString(),
    );
    await store.createInvite(
      "WAIT01",
      "r_waiting.2",
      new Date(Date.now() + 50).toISOString(),
    );
    const roomManager = new RoomManager(store);
    const wsHandlers = createWebSocketHandlers(roomManager);

    const server = Bun.serve<WsData>({
      port: 0,
      async fetch(req, srv) {
        const upgradeResp = await handleUpgrade(req, srv, store, roomManager);
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
      // Host no longer receives its own opening message on replay
      const ended = await waitForMessage(hostWs);
      expect(ended).toEqual({ type: "ended", reason: "expired" });
      const close = await waitForClose(hostWs);
      expect(close.reason).toBe("Room expired");

      const room = await store.getRoom("WAIT01");
      expect(room).not.toBeNull();
      expect(room!.status).toBe("expired");
      expect(room!.close_reason).toBeNull();
    } finally {
      roomManager.cleanupRoom("WAIT01");
      server.stop(true);
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

    const room = await store.getRoom("ROOM01");
    expect(room).not.toBeNull();
    expect(room!.status).toBe("closed");
    expect(room!.close_reason).toBe("disconnected");
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

    const room = await store.getRoom("ROOM01");
    expect(room).not.toBeNull();
    expect(room!.status).toBe("closed");
    expect(room!.close_reason).toBe("disconnected");
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
    await store.closeRoom("ROOM01", "closed");

    const ws = connectAs("host-token-123");
    const close = await waitForClose(ws);
    expect(close.code).not.toBe(1000);
  });
});

describe("RoomManager timeouts", () => {
  test("waiting rooms are tracked after the first helper connects", async () => {
    const store = createTestStore();
    await setupRoom(store);
    const roomManager = new RoomManager(store);
    const wsHandlers = createWebSocketHandlers(roomManager);

    const server = Bun.serve<WsData>({
      port: 0,
      async fetch(req, srv) {
        const upgradeResp = await handleUpgrade(req, srv, store, roomManager);
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
    }
  });

  test("idle timeout is reset on message exchange", async () => {
    const store = createTestStore();
    await setupRoom(store);
    const roomManager = new RoomManager(store);
    const wsHandlers = createWebSocketHandlers(roomManager);

    const server = Bun.serve<WsData>({
      port: 0,
      async fetch(req, srv) {
        const upgradeResp = await handleUpgrade(req, srv, store, roomManager);
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
    }
  });

  test("idle timeout expires an active room with reason expired", async () => {
    const store = createTestStore();
    await setupRoom(store);
    const roomManager = new RoomManager(store, { idleTimeoutMs: 50 });
    const wsHandlers = createWebSocketHandlers(roomManager);

    const server = Bun.serve<WsData>({
      port: 0,
      async fetch(req, srv) {
        const upgradeResp = await handleUpgrade(req, srv, store, roomManager);
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

      const room = await store.getRoom("ROOM01");
      expect(room).not.toBeNull();
      expect(room!.status).toBe("expired");
      expect(room!.closed_at).toEqual(expect.any(String));
      expect(room!.close_reason).toBeNull();
    } finally {
      roomManager.cleanupRoom("ROOM01");
      server.stop(true);
    }
  });

  test("legacy joined rooms use idle expiry even before the second socket connects", async () => {
    const store = createTestStore();
    await setupRoom(store);
    const roomManager = new RoomManager(store, { idleTimeoutMs: 50 });
    const wsHandlers = createWebSocketHandlers(roomManager);

    const server = Bun.serve<WsData>({
      port: 0,
      async fetch(req, srv) {
        const upgradeResp = await handleUpgrade(req, srv, store, roomManager);
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

      const room = await store.getRoom("ROOM01");
      expect(room).not.toBeNull();
      expect(room!.status).toBe("expired");
    } finally {
      roomManager.cleanupRoom("ROOM01");
      server.stop(true);
    }
  });

  test("pre-join messages do not start idle expiry before activation", async () => {
    const store = createTestStore();
    await store.createRoom({
      id: "WAIT10",
      hostToken: "host-token-wait10",
      openingMessage: "Opening context",
      roomStem: "r_wait10",
    });
    await store.createInvite(
      "WAIT10",
      "r_wait10.1",
      new Date(Date.now() + 200).toISOString(),
    );
    await store.createInvite(
      "WAIT10",
      "r_wait10.2",
      new Date(Date.now() + 200).toISOString(),
    );

    const roomManager = new RoomManager(store, { idleTimeoutMs: 50 });
    const host = createFakeServerSocket();

    await roomManager.addConnection("WAIT10", "host", host.ws);
    const accepted = await roomManager.handleMessage("WAIT10", "host", {
      clientMessageId: "prejoin-1",
      replyToMessageId: null,
      content: "still waiting",
    });

    expect(accepted).toBe(true);
    // Host no longer receives its own opening message on replay
    expect(host.sent[0]).toMatchObject({
      type: "ack",
      clientMessageId: "prejoin-1",
    });

    await Bun.sleep(100);

    expect(host.sent).toHaveLength(1);
    expect(host.closed).toHaveLength(0);

    const room = await store.getRoom("WAIT10");
    expect(room).not.toBeNull();
    expect(room!.status).toBe("waiting");

    roomManager.cleanupRoom("WAIT10");
  });

  test("claimed waiting rooms stay reusable after the only helper disconnects until invite expiry", async () => {
    const store = createTestStore();
    await store.createRoom({
      id: "WAIT12",
      hostToken: "host-token-wait12",
      openingMessage: "Opening context",
      roomStem: "r_wait12",
    });
    await store.createInvite(
      "WAIT12",
      "r_wait12.1",
      new Date(Date.now() + 5_000).toISOString(),
    );
    await store.createInvite(
      "WAIT12",
      "r_wait12.2",
      new Date(Date.now() + 5_000).toISOString(),
    );
    const hostClaim = await store.claimInvite("r_wait12.1", "wait12-host-claim");

    const roomManager = new RoomManager(store, { idleTimeoutMs: 50 });
    const wsHandlers = createWebSocketHandlers(roomManager);

    const server = Bun.serve<WsData>({
      port: 0,
      async fetch(req, srv) {
        const upgradeResp = await handleUpgrade(req, srv, store, roomManager);
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

      const room = await store.getRoom("WAIT12");
      expect(room).not.toBeNull();
      expect(room!.status).toBe("waiting");
      expect(room!.closed_at).toBeNull();
      expect(room!.host_connected_at).toBeNull();
    } finally {
      roomManager.cleanupRoom("WAIT12");
      server.stop(true);
    }
  });

  test("expired waiting rooms do not activate even if both sockets connect", async () => {
    const store = createTestStore();
    await store.createRoom({
      id: "WAIT11",
      hostToken: "host-token-wait11",
      openingMessage: "Opening context",
      roomStem: "r_wait11",
    });
    await store.createInvite(
      "WAIT11",
      "r_wait11.1",
      new Date(Date.now() + 50).toISOString(),
    );
    await store.createInvite(
      "WAIT11",
      "r_wait11.2",
      new Date(Date.now() + 50).toISOString(),
    );
    const guestClaim = await store.claimInvite("r_wait11.2", "wait11-guest-claim");
    await Bun.sleep(75);

    const roomManager = new RoomManager(store);
    const host = createFakeServerSocket();
    const guest = createFakeServerSocket();

    await roomManager.addConnection("WAIT11", "host", host.ws);
    await roomManager.addConnection("WAIT11", "guest", guest.ws);

    expect(host.sent).toEqual([{ type: "ended", reason: "expired" }]);
    expect(guest.sent).toEqual([{ type: "ended", reason: "expired" }]);
    expect(host.closed).toEqual([{ code: 1000, reason: "Room expired" }]);
    expect(guest.closed).toEqual([{ code: 1000, reason: "Room expired" }]);

    const room = await store.getRoom("WAIT11");
    expect(room).not.toBeNull();
    expect(room!.status).toBe("expired");
    expect(guestClaim.role).toBe("guest");
  });
});

describe("handleUpgrade — token validation", () => {
  test("rejects when token does not match room ID", async () => {
    const store = createTestStore();
    await store.createRoom({ id: "ROOM01", hostToken: "host-token-123" });
    await store.joinRoom("ROOM01", "guest-token-456");
    await store.createRoom({ id: "ROOM02", hostToken: "other-host" });
    await store.joinRoom("ROOM02", "other-guest");
    const roomManager = new RoomManager(store);

    const mockServer = { upgrade: () => true } as any;

    const req = new Request("http://localhost/rooms/ROOM02/ws?token=host-token-123");
    const result = await handleUpgrade(req, mockServer, store, roomManager);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });

  test("rejects expired room", async () => {
    const store = createTestStore();
    await store.createRoom({ id: "ROOM01", hostToken: "host-token-123" });
    await store.expireRoom("ROOM01");
    const roomManager = new RoomManager(store);

    const mockServer = { upgrade: () => true } as any;
    const req = new Request("http://localhost/rooms/ROOM01/ws?token=host-token-123");
    const result = await handleUpgrade(req, mockServer, store, roomManager);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(410);
  });

  test("rejects claimed waiting rooms after the original invite expiry has passed", async () => {
    const store = createTestStore();
    await store.createRoom({
      id: "WAIT13",
      hostToken: "host-token-wait13",
      openingMessage: "Opening context",
      roomStem: "r_wait13",
    });
    await store.createInvite(
      "WAIT13",
      "r_wait13.1",
      new Date(Date.now() + 50).toISOString(),
    );
    await store.createInvite(
      "WAIT13",
      "r_wait13.2",
      new Date(Date.now() + 50).toISOString(),
    );
    const hostClaim = await store.claimInvite("r_wait13.1", "wait13-host-claim");
    const roomManager = new RoomManager(store, { idleTimeoutMs: 5_000 });

    await Bun.sleep(75);

    const mockServer = { upgrade: () => true } as any;
    const req = new Request(`http://localhost/rooms/WAIT13/ws?token=${hostClaim.sessionToken}`);
    const result = await handleUpgrade(req, mockServer, store, roomManager);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(410);

    const room = await store.getRoom("WAIT13");
    expect(room).not.toBeNull();
    expect(room!.status).toBe("expired");
  });

  test("rejects duplicate-role attach with a deterministic 409 response", async () => {
    const store = createTestStore();
    await store.createRoom({ id: "ROOM03", hostToken: "host-token-duplicate" });
    const roomManager = new RoomManager(store);
    const host = createFakeServerSocket();
    await roomManager.addConnection("ROOM03", "host", host.ws);

    const mockServer = { upgrade: () => true } as any;
    const req = new Request("http://localhost/rooms/ROOM03/ws?token=host-token-duplicate");
    const result = await handleUpgrade(req, mockServer, store, roomManager);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(409);
    expect(await result!.text()).toContain("Role already connected");

    roomManager.cleanupRoom("ROOM03");
  });
});
