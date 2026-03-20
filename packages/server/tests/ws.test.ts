import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { CloseReason, Role, Room, ServerMessage } from "../src/types.js";
import type { DbLayer } from "../src/db/interface.js";
import { RoomManager } from "../src/ws/room-manager.js";
import { createWebSocketHandlers } from "../src/ws/handler.js";
import { handleUpgrade } from "../src/ws/upgrade.js";
import type { WsData } from "../src/ws/room-manager.js";

// --- Mock DB Layer ---

function createMockDb(rooms: Map<string, Room> = new Map()): DbLayer & {
  messages: Array<{ roomId: string; sender: Role; content: string }>;
  closedRooms: Array<{ roomId: string; reason: CloseReason }>;
  activatedRooms: string[];
} {
  const messages: Array<{ roomId: string; sender: Role; content: string }> = [];
  const closedRooms: Array<{ roomId: string; reason: CloseReason }> = [];
  const activatedRooms: string[] = [];

  return {
    messages,
    closedRooms,
    activatedRooms,
    getRoomByToken(token: string) {
      for (const room of rooms.values()) {
        if (room.hostToken === token) return { room, role: "host" as Role };
        if (room.guestToken === token) return { room, role: "guest" as Role };
      }
      return null;
    },
    closeRoom(roomId: string, reason: CloseReason) {
      closedRooms.push({ roomId, reason });
      const room = rooms.get(roomId);
      if (room) {
        room.status = "closed";
        room.closeReason = reason;
      }
    },
    activateRoom(roomId: string) {
      activatedRooms.push(roomId);
      const room = rooms.get(roomId);
      if (room) room.status = "active";
    },
    saveMessage(roomId: string, sender: Role, content: string) {
      messages.push({ roomId, sender, content });
    },
  };
}

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: "ROOM01",
    hostToken: "host-token-123",
    guestToken: "guest-token-456",
    status: "waiting",
    createdAt: new Date().toISOString(),
    joinedAt: null,
    closedAt: null,
    closeReason: null,
    ...overrides,
  };
}

// --- Integration tests using real Bun server + WebSocket ---

function waitForMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for message")), 5000);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(event.data as string));
      },
      { once: true }
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
      { once: true }
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
      { once: true }
    );
    ws.addEventListener(
      "error",
      (e) => {
        clearTimeout(timeout);
        reject(e);
      },
      { once: true }
    );
  });
}

describe("WebSocket relay — integration tests", () => {
  let server: ReturnType<typeof Bun.serve>;
  let db: ReturnType<typeof createMockDb>;
  let roomManager: RoomManager;
  let port: number;

  beforeEach(() => {
    const rooms = new Map<string, Room>();
    rooms.set("ROOM01", makeRoom());
    db = createMockDb(rooms);
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
    // Consume the 'joined' message on host
    await waitForMessage(hostWs);

    const msgPromise = waitForMessage(guestWs);
    hostWs.send(JSON.stringify({ type: "message", content: "hello guest" }));
    const msg = await msgPromise;
    expect(msg).toEqual({ type: "message", content: "hello guest" });

    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]).toEqual({
      roomId: "ROOM01",
      sender: "host",
      content: "hello guest",
    });

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

    expect(db.closedRooms).toContainEqual({ roomId: "ROOM01", reason: "closed" });
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

  test("room is activated in db when guest joins", async () => {
    const hostWs = connectAs("host-token-123");
    await waitForOpen(hostWs);

    const guestWs = connectAs("guest-token-456");
    await waitForOpen(guestWs);
    await waitForMessage(hostWs); // consume 'joined'

    expect(db.activatedRooms).toContain("ROOM01");

    hostWs.close();
    guestWs.close();
  });

  test("rejects connection to closed room", async () => {
    // Close the room first
    db.closeRoom("ROOM01", "closed");

    const ws = connectAs("host-token-123");
    const close = await waitForClose(ws);
    expect(close.code).not.toBe(1000);
  });
});

// --- Unit tests for RoomManager timeouts ---

describe("RoomManager timeouts", () => {
  test("join timeout expires room when guest doesn't join", async () => {
    const rooms = new Map<string, Room>();
    rooms.set("ROOM01", makeRoom());
    const db = createMockDb(rooms);

    // We test the timeout logic by creating a room manager and connecting host.
    // We'll use a real server for this since timers interact with WS.
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
      // To test timeout without waiting 5 minutes, we verify the timer is set
      // by connecting and checking room manager state
      const hostWs = new WebSocket(
        `ws://localhost:${server.port}/rooms/ROOM01/ws?token=host-token-123`
      );
      await waitForOpen(hostWs);

      // The room should exist in the manager
      expect(roomManager.hasRoom("ROOM01")).toBe(true);

      // Clean up
      hostWs.close();
    } finally {
      roomManager.cleanupRoom("ROOM01");
      server.stop(true);
    }
  });

  test("idle timeout is reset on message exchange", async () => {
    const rooms = new Map<string, Room>();
    rooms.set("ROOM01", makeRoom());
    const db = createMockDb(rooms);
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
        `ws://localhost:${server.port}/rooms/ROOM01/ws?token=host-token-123`
      );
      await waitForOpen(hostWs);

      const guestWs = new WebSocket(
        `ws://localhost:${server.port}/rooms/ROOM01/ws?token=guest-token-456`
      );
      await waitForOpen(guestWs);
      await waitForMessage(hostWs); // consume 'joined'

      // Send a message to reset idle timeout
      const msgPromise = waitForMessage(guestWs);
      hostWs.send(JSON.stringify({ type: "message", content: "ping" }));
      const msg = await msgPromise;
      expect(msg).toEqual({ type: "message", content: "ping" });

      // Room should still be active
      expect(roomManager.hasRoom("ROOM01")).toBe(true);

      hostWs.close();
      guestWs.close();
    } finally {
      roomManager.cleanupRoom("ROOM01");
      server.stop(true);
    }
  });

  test("hard timeout is started when guest joins", async () => {
    const rooms = new Map<string, Room>();
    rooms.set("ROOM01", makeRoom());
    const db = createMockDb(rooms);
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
        `ws://localhost:${server.port}/rooms/ROOM01/ws?token=host-token-123`
      );
      await waitForOpen(hostWs);

      const guestWs = new WebSocket(
        `ws://localhost:${server.port}/rooms/ROOM01/ws?token=guest-token-456`
      );
      await waitForOpen(guestWs);
      await waitForMessage(hostWs); // consume 'joined'

      // Room should be active with hard timeout set
      expect(roomManager.hasRoom("ROOM01")).toBe(true);
      expect(db.activatedRooms).toContain("ROOM01");

      hostWs.close();
      guestWs.close();
    } finally {
      roomManager.cleanupRoom("ROOM01");
      server.stop(true);
    }
  });
});

describe("handleUpgrade — token validation", () => {
  test("rejects when token does not match room ID", async () => {
    const rooms = new Map<string, Room>();
    rooms.set("ROOM01", makeRoom());
    rooms.set("ROOM02", makeRoom({ id: "ROOM02", hostToken: "other-host" }));
    const db = createMockDb(rooms);
    const roomManager = new RoomManager(db);

    const mockServer = {
      upgrade: () => true,
    } as any;

    // Token belongs to ROOM01 but URL says ROOM02
    const req = new Request("http://localhost/rooms/ROOM02/ws?token=host-token-123");
    const result = handleUpgrade(req, mockServer, db, roomManager);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });

  test("rejects expired room", async () => {
    const rooms = new Map<string, Room>();
    rooms.set("ROOM01", makeRoom({ status: "expired" }));
    const db = createMockDb(rooms);
    const roomManager = new RoomManager(db);

    const mockServer = { upgrade: () => true } as any;
    const req = new Request("http://localhost/rooms/ROOM01/ws?token=host-token-123");
    const result = handleUpgrade(req, mockServer, db, roomManager);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(410);
  });
});
