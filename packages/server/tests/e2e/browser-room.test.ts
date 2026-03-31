import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { ServerMessage, StoredRoom } from "@agentmeets/shared";
import { initializeSchema } from "../../src/db/schema.js";
import { RoomManager } from "../../src/ws/room-manager.js";
import { createWebSocketHandlers } from "../../src/ws/handler.js";
import { handleUpgrade } from "../../src/ws/upgrade.js";
import type { WsData } from "../../src/ws/room-manager.js";
import { inviteRoutes } from "../../src/routes/invites.js";
import { publicRoomRoutes } from "../../src/routes/public-rooms.js";
import { roomRoutes } from "../../src/routes/rooms.js";

let db: Database;
let app: Hono;
let server: ReturnType<typeof Bun.serve>;
let roomManager: RoomManager;
let port: number;

async function buildApp(): Promise<Hono> {
  const nextApp = new Hono();
  nextApp.route("/", roomRoutes(db));
  nextApp.route("/", inviteRoutes(db));
  nextApp.route("/", publicRoomRoutes(db));
  return nextApp;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

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
      (event) => {
        clearTimeout(timeout);
        reject(event);
      },
      { once: true },
    );
  });
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

beforeEach(async () => {
  db = new Database(":memory:");
  initializeSchema(db);
  app = await buildApp();
  roomManager = new RoomManager(db, { idleTimeoutMs: 50 });
  const wsHandlers = createWebSocketHandlers(roomManager);
  server = Bun.serve<WsData>({
    port: 0,
    fetch(req, srv) {
      const upgradeResponse = handleUpgrade(req, srv, db, roomManager);
      if (upgradeResponse) {
        return upgradeResponse;
      }

      const url = new URL(req.url);
      if (url.pathname.match(/^\/rooms\/[^/]+\/ws$/)) {
        return undefined as unknown as Response;
      }

      return app.fetch(req);
    },
    websocket: wsHandlers,
  });
  port = server.port;
});

afterEach(() => {
  server.stop(true);
  db.close();
});

describe("browser room presentation", () => {
  test("public room and invite manifest return 410 after idle expiry", async () => {
    const baseUrl = `http://localhost:${port}`;

    const createResponse = await fetch(`${baseUrl}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingMessage: "Browser-safe room flow." }),
    });
    expect(createResponse.status).toBe(201);

    const created = (await createResponse.json()) as {
      roomId: string;
      roomStem: string;
      hostAgentLink: string;
      guestAgentLink: string;
    };
    expect(created.hostAgentLink).toContain(".1");
    expect(created.guestAgentLink).toContain(".2");
    const hostInviteToken = new URL(created.hostAgentLink).pathname.split("/").pop()!;
    const guestInviteToken = new URL(created.guestAgentLink).pathname.split("/").pop()!;

    const hostClaimResponse = await fetch(`${baseUrl}/invites/${hostInviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "browser-room-host-claim" },
    });
    expect(hostClaimResponse.status).toBe(200);
    const hostClaim = (await hostClaimResponse.json()) as { sessionToken: string };

    const guestClaimResponse = await fetch(`${baseUrl}/invites/${guestInviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "browser-room-guest-claim" },
    });
    expect(guestClaimResponse.status).toBe(200);
    const guestClaim = (await guestClaimResponse.json()) as { sessionToken: string };

    const hostWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${hostClaim.sessionToken}`,
    );
    await waitForOpen(hostWs);

    const guestWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${guestClaim.sessionToken}`,
    );
    await waitForOpen(guestWs);

    expect(await waitForMessage(hostWs)).toEqual({ type: "room_active" });
    expect(await waitForMessage(guestWs)).toEqual({ type: "room_active" });
    expect(await waitForMessage(hostWs)).toEqual({ type: "ended", reason: "expired" });
    expect(await waitForMessage(guestWs)).toEqual({ type: "ended", reason: "expired" });

    const publicRoom = await fetch(`${baseUrl}/public/rooms/${created.roomStem}`);
    expect(publicRoom.status).toBe(410);
    expect(await publicRoom.json()).toEqual({ error: "room_expired" });

    const manifest = await fetch(`${baseUrl}/j/${hostInviteToken}`);
    expect(manifest.status).toBe(410);
    expect(await manifest.json()).toEqual({ error: "invite_expired" });

    const room = db
      .prepare("SELECT status, closed_at, close_reason FROM rooms WHERE id = ?")
      .get(created.roomId) as Pick<StoredRoom, "status" | "closed_at" | "close_reason">;
    expect(room.status).toBe("expired");
    expect(room.closed_at).toEqual(expect.any(String));
    expect(room.close_reason).toBeNull();
  });

  test("legacy join path rejects rooms after the invite lifetime elapses", async () => {
    const baseUrl = `http://localhost:${port}`;

    const createResponse = await fetch(`${baseUrl}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        openingMessage: "Legacy join expiry coverage.",
        inviteTtlSeconds: 1,
      }),
    });
    expect(createResponse.status).toBe(201);

    const created = (await createResponse.json()) as { roomId: string };

    await Bun.sleep(1_100);

    const joinResponse = await fetch(`${baseUrl}/rooms/${created.roomId}/join`, {
      method: "POST",
    });
    expect(joinResponse.status).toBe(410);
    expect(await joinResponse.json()).toEqual({ error: "room_expired" });

    const room = db
      .prepare("SELECT status, closed_at FROM rooms WHERE id = ?")
      .get(created.roomId) as Pick<StoredRoom, "status" | "closed_at">;
    expect(room.status).toBe("expired");
    expect(room.closed_at).toEqual(expect.any(String));
  });

  test("legacy join path does not expire an already-claimed room after invite expiry", async () => {
    const baseUrl = `http://localhost:${port}`;

    const createResponse = await fetch(`${baseUrl}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        openingMessage: "Claimed room should stay claim-valid.",
        inviteTtlSeconds: 1,
      }),
    });
    expect(createResponse.status).toBe(201);

    const created = (await createResponse.json()) as {
      roomId: string;
      guestAgentLink: string;
    };
    const guestInviteToken = new URL(created.guestAgentLink).pathname.split("/").pop()!;

    const guestClaimResponse = await fetch(`${baseUrl}/invites/${guestInviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "legacy-join-claimed-room" },
    });
    expect(guestClaimResponse.status).toBe(200);

    await Bun.sleep(1_100);

    const joinResponse = await fetch(`${baseUrl}/rooms/${created.roomId}/join`, {
      method: "POST",
    });
    expect(joinResponse.status).toBe(409);
    expect(await joinResponse.json()).toEqual({ error: "room_full" });

    const room = db
      .prepare("SELECT status, guest_token FROM rooms WHERE id = ?")
      .get(created.roomId) as Pick<StoredRoom, "status" | "guest_token">;
    expect(room.status).toBe("waiting");
    expect(room.guest_token).toEqual(expect.any(String));
  });

  test("claimed invite sessions can still activate after the original invite TTL elapses", async () => {
    const baseUrl = `http://localhost:${port}`;
    (roomManager as any).idleTimeoutMs = 2_000;

    const createResponse = await fetch(`${baseUrl}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        openingMessage: "Claim first, connect later.",
        inviteTtlSeconds: 1,
      }),
    });
    expect(createResponse.status).toBe(201);

    const created = (await createResponse.json()) as {
      roomId: string;
      hostAgentLink: string;
      guestAgentLink: string;
    };
    const hostInviteToken = new URL(created.hostAgentLink).pathname.split("/").pop()!;
    const guestInviteToken = new URL(created.guestAgentLink).pathname.split("/").pop()!;

    const hostClaimResponse = await fetch(`${baseUrl}/invites/${hostInviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "claimed-host-after-expiry" },
    });
    expect(hostClaimResponse.status).toBe(200);
    const hostClaim = (await hostClaimResponse.json()) as { sessionToken: string };

    const guestClaimResponse = await fetch(`${baseUrl}/invites/${guestInviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "claimed-guest-after-expiry" },
    });
    expect(guestClaimResponse.status).toBe(200);
    const guestClaim = (await guestClaimResponse.json()) as { sessionToken: string };

    await Bun.sleep(1_100);

    const hostWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${hostClaim.sessionToken}`,
    );
    await waitForOpen(hostWs);

    const guestWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${guestClaim.sessionToken}`,
    );
    await waitForOpen(guestWs);

    expect(await waitForMessage(hostWs)).toEqual({ type: "room_active" });
    expect(await waitForMessage(guestWs)).toEqual({ type: "room_active" });

    hostWs.close();
    guestWs.close();
  });

  test("claimed rooms expire after a disconnect and surface as expired over HTTP", async () => {
    const baseUrl = `http://localhost:${port}`;

    const createResponse = await fetch(`${baseUrl}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingMessage: "Claim, connect once, then abandon." }),
    });
    expect(createResponse.status).toBe(201);

    const created = (await createResponse.json()) as {
      roomId: string;
      roomStem: string;
      hostAgentLink: string;
    };
    const hostInviteToken = new URL(created.hostAgentLink).pathname.split("/").pop()!;

    const hostClaimResponse = await fetch(`${baseUrl}/invites/${hostInviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "claimed-disconnect-expiry-host" },
    });
    expect(hostClaimResponse.status).toBe(200);
    const hostClaim = (await hostClaimResponse.json()) as { sessionToken: string };

    const hostWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${hostClaim.sessionToken}`,
    );
    await waitForOpen(hostWs);
    hostWs.close();

    await Bun.sleep(100);

    const manifest = await fetch(`${baseUrl}/j/${hostInviteToken}`);
    expect(manifest.status).toBe(410);
    expect(await manifest.json()).toEqual({ error: "invite_expired" });

    const publicRoom = await fetch(`${baseUrl}/public/rooms/${created.roomStem}`);
    expect(publicRoom.status).toBe(410);
    expect(await publicRoom.json()).toEqual({ error: "room_expired" });

    const room = db
      .prepare("SELECT status, closed_at FROM rooms WHERE id = ?")
      .get(created.roomId) as Pick<StoredRoom, "status" | "closed_at">;
    expect(room.status).toBe("expired");
    expect(room.closed_at).toEqual(expect.any(String));
  });

});
