import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { ServerMessage } from "@agentmeets/shared";
import { initializeSchema } from "../../src/db/schema.js";
import { RoomManager } from "../../src/ws/room-manager.js";
import { createWebSocketHandlers } from "../../src/ws/handler.js";
import { handleUpgrade } from "../../src/ws/upgrade.js";
import type { WsData } from "../../src/ws/room-manager.js";
import { roomRoutes } from "../../src/routes/rooms.js";
import { inviteRoutes } from "../../src/routes/invites.js";

let db: Database;
let app: Hono;
let server: ReturnType<typeof Bun.serve>;
let roomManager: RoomManager;
let port: number;

async function buildApp(): Promise<Hono> {
  const nextApp = new Hono();
  nextApp.route("/", roomRoutes(db));
  nextApp.route("/", inviteRoutes(db));
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
  roomManager = new RoomManager(db);
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

describe("invite flow", () => {
  test("create room -> inspect manifest -> claim invite -> activate over websockets", async () => {
    const baseUrl = `http://localhost:${port}`;

    const createResponse = await fetch(`${baseUrl}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingMessage: "Let's debug the release pipeline." }),
    });
    expect(createResponse.status).toBe(201);

    const created = await createResponse.json();
    expect(created).toEqual({
      roomId: expect.stringMatching(/^[A-Z0-9]{6}$/),
      roomStem: expect.stringMatching(/^r_[A-Za-z0-9_-]+$/),
      hostAgentLink: expect.stringMatching(
        new RegExp(`^http://localhost:${port}/j/r_[A-Za-z0-9_-]+\\.1$`),
      ),
      guestAgentLink: expect.stringMatching(
        new RegExp(`^http://localhost:${port}/j/r_[A-Za-z0-9_-]+\\.2$`),
      ),
      inviteExpiresAt: expect.any(String),
      status: "waiting_for_join",
    });

    const hostInviteToken = new URL(created.hostAgentLink).pathname.split("/").pop()!;
    const guestInviteToken = new URL(created.guestAgentLink).pathname.split("/").pop()!;

    const manifestBeforeClaim = await fetch(`${baseUrl}/j/${hostInviteToken}`);
    expect(manifestBeforeClaim.status).toBe(200);
    expect(await manifestBeforeClaim.json()).toEqual({
      roomId: created.roomId,
      roomStem: created.roomStem,
      role: "host",
      status: "waiting_for_join",
      openingMessage: "Let's debug the release pipeline.",
      expiresAt: expect.any(String),
    });

    const hostClaimResponse = await fetch(`${baseUrl}/invites/${hostInviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "invite-flow-host-claim" },
    });
    expect(hostClaimResponse.status).toBe(200);
    const hostClaim = await hostClaimResponse.json();
    expect(hostClaim).toEqual({
      roomId: created.roomId,
      role: "host",
      sessionToken: expect.any(String),
      status: "activating",
    });

    const guestClaimResponse = await fetch(`${baseUrl}/invites/${guestInviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "invite-flow-guest-claim" },
    });
    expect(guestClaimResponse.status).toBe(200);
    const guestClaim = await guestClaimResponse.json();
    expect(guestClaim).toEqual({
      roomId: created.roomId,
      role: "guest",
      sessionToken: expect.any(String),
      status: "activating",
    });

    const roomRow = db
      .prepare("SELECT room_stem, host_token, guest_token, joined_at, status FROM rooms WHERE id = ?")
      .get(created.roomId) as {
      room_stem: string | null;
      host_token: string | null;
      guest_token: string | null;
      joined_at: string | null;
      status: string;
    };
    expect(roomRow.room_stem).toBe(created.roomStem);
    expect(roomRow.host_token).toBe(hostClaim.sessionToken);
    expect(roomRow.guest_token).toBe(guestClaim.sessionToken);
    expect(roomRow.joined_at).toBeNull();
    expect(roomRow.status).toBe("waiting");

    const hostWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${hostClaim.sessionToken}`,
    );
    await waitForOpen(hostWs);

    const hostActivationPromise = waitForMessage(hostWs);
    const guestWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${guestClaim.sessionToken}`,
    );
    await waitForOpen(guestWs);

    expect(await hostActivationPromise).toEqual({ type: "room_active" });
    expect(await waitForMessage(guestWs)).toEqual({ type: "room_active" });

    const manifestAfterActivation = await fetch(`${baseUrl}/j/${guestInviteToken}`);
    expect(manifestAfterActivation.status).toBe(200);
    expect(await manifestAfterActivation.json()).toEqual({
      roomId: created.roomId,
      roomStem: created.roomStem,
      role: "guest",
      status: "active",
      openingMessage: "Let's debug the release pipeline.",
      expiresAt: expect.any(String),
    });

    const activatedRoomRow = db
      .prepare("SELECT host_token, guest_token, joined_at, status FROM rooms WHERE id = ?")
      .get(created.roomId) as {
      host_token: string | null;
      guest_token: string | null;
      joined_at: string | null;
      status: string;
    };
    expect(activatedRoomRow.host_token).toBe(hostClaim.sessionToken);
    expect(activatedRoomRow.guest_token).toBe(guestClaim.sessionToken);
    expect(activatedRoomRow.joined_at).toEqual(expect.any(String));
    expect(activatedRoomRow.status).toBe("active");

    hostWs.close();
    guestWs.close();
  });

  test("invite-link bootstrap failures surface locally as JSON without any browser redirect fallback", async () => {
    const baseUrl = `http://localhost:${port}`;

    const missingManifest = await fetch(`${baseUrl}/j/not-a-real-invite`);
    expect(missingManifest.status).toBe(404);
    expect(missingManifest.headers.get("content-type")).toContain("application/json");
    expect(missingManifest.headers.get("location")).toBeNull();
    expect(await missingManifest.json()).toEqual({
      error: "invite_not_found",
    });

    const createResponse = await fetch(`${baseUrl}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingMessage: "This invite should expire before bootstrap." }),
    });
    expect(createResponse.status).toBe(201);

    const created = (await createResponse.json()) as {
      roomId: string;
      hostAgentLink: string;
      guestAgentLink: string;
    };
    const guestInviteToken = new URL(created.guestAgentLink).pathname.split("/").pop()!;

    db.prepare("UPDATE invites SET expires_at = ? WHERE room_id = ?").run(
      new Date(Date.now() - 60_000).toISOString(),
      created.roomId,
    );

    const expiredManifest = await fetch(`${baseUrl}/j/${guestInviteToken}`);
    expect(expiredManifest.status).toBe(410);
    expect(expiredManifest.headers.get("content-type")).toContain("application/json");
    expect(expiredManifest.headers.get("location")).toBeNull();
    expect(await expiredManifest.json()).toEqual({
      error: "invite_expired",
    });

    const expiredClaim = await fetch(`${baseUrl}/invites/${guestInviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "expired-bootstrap-claim" },
    });
    expect(expiredClaim.status).toBe(410);
    expect(expiredClaim.headers.get("content-type")).toContain("application/json");
    expect(expiredClaim.headers.get("location")).toBeNull();
    expect(await expiredClaim.json()).toEqual({
      error: "invite_expired",
    });
  });
});
