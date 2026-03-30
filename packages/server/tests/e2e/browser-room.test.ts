import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ServerMessage } from "@agentmeets/shared";
import {
  createFakeAgentMeetsStore,
  type AgentMeetsStore,
} from "../../src/db/index.js";
import { RoomManager } from "../../src/ws/room-manager.js";
import { createWebSocketHandlers } from "../../src/ws/handler.js";
import { handleUpgrade } from "../../src/ws/upgrade.js";
import type { WsData } from "../../src/ws/room-manager.js";
import { inviteRoutes } from "../../src/routes/invites.js";
import { publicRoomRoutes } from "../../src/routes/public-rooms.js";
import { roomRoutes } from "../../src/routes/rooms.js";

let store: AgentMeetsStore;
let app: Hono;
let server: ReturnType<typeof Bun.serve>;
let roomManager: RoomManager;
let port: number;

async function buildApp(): Promise<Hono> {
  const nextApp = new Hono();
  nextApp.route("/", roomRoutes(store));
  nextApp.route("/", inviteRoutes(store));
  nextApp.route("/", publicRoomRoutes(store));
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

beforeEach(async () => {
  store = createFakeAgentMeetsStore();
  app = await buildApp();
  roomManager = new RoomManager(store, { idleTimeoutMs: 50 });
  const wsHandlers = createWebSocketHandlers(roomManager);
  server = Bun.serve<WsData>({
    port: 0,
    async fetch(req, srv) {
      const upgradeResponse = await handleUpgrade(req, srv, store, roomManager);
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
  roomManager.shutdown();
  server.stop(true);
});

describe("browser room presentation", () => {
  test("public room status reflects the actually connected role instead of invite claims", async () => {
    const baseUrl = `http://localhost:${port}`;
    (roomManager as { idleTimeoutMs: number }).idleTimeoutMs = 2_000;

    const createResponse = await fetch(`${baseUrl}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingMessage: "Track real connection state." }),
    });
    expect(createResponse.status).toBe(201);

    const created = (await createResponse.json()) as {
      roomId: string;
      roomStem: string;
      hostAgentLink: string;
      guestAgentLink: string;
    };
    const hostInviteToken = new URL(created.hostAgentLink).pathname.split("/").pop()!;
    const guestInviteToken = new URL(created.guestAgentLink).pathname.split("/").pop()!;

    const hostClaimResponse = await fetch(`${baseUrl}/invites/${hostInviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "browser-room-host-only-claim" },
    });
    expect(hostClaimResponse.status).toBe(200);
    const hostClaim = (await hostClaimResponse.json()) as { sessionToken: string };

    const hostWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${hostClaim.sessionToken}`,
    );
    await waitForOpen(hostWs);

    const hostOnlyRoom = await fetch(`${baseUrl}/public/rooms/${created.roomStem}`);
    expect(hostOnlyRoom.status).toBe(200);
    expect(await hostOnlyRoom.json()).toMatchObject({
      roomStem: created.roomStem,
      status: "waiting_for_guest",
    });

    hostWs.close();
    await Bun.sleep(50);

    const guestClaimResponse = await fetch(`${baseUrl}/invites/${guestInviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "browser-room-guest-only-claim" },
    });
    expect(guestClaimResponse.status).toBe(200);
    const guestClaim = (await guestClaimResponse.json()) as { sessionToken: string };

    const guestWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${guestClaim.sessionToken}`,
    );
    await waitForOpen(guestWs);

    const guestOnlyRoom = await fetch(`${baseUrl}/public/rooms/${created.roomStem}`);
    expect(guestOnlyRoom.status).toBe(200);
    expect(await guestOnlyRoom.json()).toMatchObject({
      roomStem: created.roomStem,
      status: "waiting_for_host",
    });

    guestWs.close();
  });

  test("public room returns ended after an active room disconnects", async () => {
    const baseUrl = `http://localhost:${port}`;
    (roomManager as { idleTimeoutMs: number }).idleTimeoutMs = 2_000;

    const createResponse = await fetch(`${baseUrl}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingMessage: "Track ended browser state." }),
    });
    expect(createResponse.status).toBe(201);

    const created = (await createResponse.json()) as {
      roomId: string;
      roomStem: string;
      hostAgentLink: string;
      guestAgentLink: string;
    };
    const hostInviteToken = new URL(created.hostAgentLink).pathname.split("/").pop()!;
    const guestInviteToken = new URL(created.guestAgentLink).pathname.split("/").pop()!;

    const hostClaimResponse = await fetch(`${baseUrl}/invites/${hostInviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "browser-room-ended-host" },
    });
    expect(hostClaimResponse.status).toBe(200);
    const hostClaim = (await hostClaimResponse.json()) as { sessionToken: string };

    const guestClaimResponse = await fetch(`${baseUrl}/invites/${guestInviteToken}/claim`, {
      method: "POST",
      headers: { "Idempotency-Key": "browser-room-ended-guest" },
    });
    expect(guestClaimResponse.status).toBe(200);
    const guestClaim = (await guestClaimResponse.json()) as { sessionToken: string };

    const hostWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${hostClaim.sessionToken}`,
    );
    await waitForOpen(hostWs);
    // Host no longer receives its own opening message on replay

    const hostActivationPromise = waitForMessage(hostWs);
    const guestWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${guestClaim.sessionToken}`,
    );
    const guestMessagesPromise = waitForMessages(guestWs, 2);
    await waitForOpen(guestWs);

    expect(await hostActivationPromise).toEqual({ type: "room_active", roomId: created.roomId });
    const guestMessages = await guestMessagesPromise;
    expect(guestMessages[0]).toMatchObject({
      type: "message",
      sender: "host",
      content: "Track ended browser state.",
    });
    expect(guestMessages[1]).toEqual({ type: "room_active", roomId: created.roomId });

    const endedPromise = waitForMessage(guestWs);
    hostWs.close();
    expect(await endedPromise).toEqual({ type: "ended", reason: "disconnected" });

    const publicRoom = await fetch(`${baseUrl}/public/rooms/${created.roomStem}`);
    expect(publicRoom.status).toBe(200);
    expect(await publicRoom.json()).toMatchObject({
      roomStem: created.roomStem,
      status: "ended",
    });
  });

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
    // Host no longer receives its own opening message on replay

    const hostActivationPromise = waitForMessage(hostWs);
    const guestWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${guestClaim.sessionToken}`,
    );
    const guestMessagesPromise = waitForMessages(guestWs, 2);
    await waitForOpen(guestWs);

    const guestMessages = await guestMessagesPromise;
    expect(guestMessages[0]).toMatchObject({
      type: "message",
      sender: "host",
      content: "Browser-safe room flow.",
    });
    expect(guestMessages[1]).toEqual({ type: "room_active", roomId: created.roomId });
    expect(await hostActivationPromise).toEqual({ type: "room_active", roomId: created.roomId });
    expect(await waitForMessage(hostWs)).toEqual({ type: "ended", reason: "expired" });
    expect(await waitForMessage(guestWs)).toEqual({ type: "ended", reason: "expired" });

    const publicRoom = await fetch(`${baseUrl}/public/rooms/${created.roomStem}`);
    expect(publicRoom.status).toBe(410);
    expect(await publicRoom.json()).toEqual({ error: "room_expired" });

    const manifest = await fetch(`${baseUrl}/j/${hostInviteToken}`);
    expect(manifest.status).toBe(410);
    expect(await manifest.json()).toEqual({ error: "invite_expired" });

    const room = await store.getRoom(created.roomId);
    expect(room).not.toBeNull();
    expect(room!.status).toBe("expired");
    expect(room!.closed_at).toEqual(expect.any(String));
    expect(room!.close_reason).toBeNull();
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

    const room = await store.getRoom(created.roomId);
    expect(room).not.toBeNull();
    expect(room!.status).toBe("expired");
    expect(room!.closed_at).toEqual(expect.any(String));
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

    const room = await store.getRoom(created.roomId);
    expect(room).not.toBeNull();
    expect(room!.status).toBe("waiting");
    expect(room!.guest_token).toEqual(expect.any(String));
  });

  test("claimed invite sessions cannot activate after the original invite TTL elapses", async () => {
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

    const manifest = await fetch(`${baseUrl}/j/${hostInviteToken}`);
    expect(manifest.status).toBe(410);
    expect(await manifest.json()).toEqual({ error: "invite_expired" });

    const publicRoom = await fetch(`${baseUrl}/public/rooms/${created.roomStem}`);
    expect(publicRoom.status).toBe(410);
    expect(await publicRoom.json()).toEqual({ error: "room_expired" });

    const hostWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${hostClaim.sessionToken}`,
    );
    const guestWs = new WebSocket(
      `ws://localhost:${port}/rooms/${created.roomId}/ws?token=${guestClaim.sessionToken}`,
    );

    const [hostClose, guestClose] = await Promise.all([
      new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout waiting for close")), 5000);
        hostWs.addEventListener(
          "close",
          (event) => {
            clearTimeout(timeout);
            resolve({ code: event.code, reason: event.reason });
          },
          { once: true },
        );
      }),
      new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout waiting for close")), 5000);
        guestWs.addEventListener(
          "close",
          (event) => {
            clearTimeout(timeout);
            resolve({ code: event.code, reason: event.reason });
          },
          { once: true },
        );
      }),
    ]);
    expect(hostClose.code).not.toBe(1000);
    expect(guestClose.code).not.toBe(1000);

    const room = await store.getRoom(created.roomId);
    expect(room).not.toBeNull();
    expect(room!.status).toBe("expired");
    expect(room!.closed_at).toEqual(expect.any(String));
  });

  test("claimed rooms fall back to waiting after a disconnect until the invite expires", async () => {
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
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({
      roomId: created.roomId,
      roomStem: created.roomStem,
      role: "host",
      status: "waiting_for_both",
      openingMessage: "Claim, connect once, then abandon.",
    });

    const publicRoom = await fetch(`${baseUrl}/public/rooms/${created.roomStem}`);
    expect(publicRoom.status).toBe(200);
    expect(await publicRoom.json()).toMatchObject({
      roomStem: created.roomStem,
      status: "waiting_for_both",
    });

    const room = await store.getRoom(created.roomId);
    expect(room).not.toBeNull();
    expect(room!.status).toBe("waiting");
    expect(room!.closed_at).toBeNull();
    expect(room!.host_connected_at).toBeNull();
  });

  test("invite links render a thin informational landing for html browsers", async () => {
    const baseUrl = `http://localhost:${port}`;

    const createResponse = await fetch(`${baseUrl}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingMessage: "Thin invite landing only." }),
    });
    expect(createResponse.status).toBe(201);

    const created = (await createResponse.json()) as {
      hostAgentLink: string;
    };
    const hostInviteToken = new URL(created.hostAgentLink).pathname.split("/").pop()!;

    const html = await fetch(`${baseUrl}/j/${hostInviteToken}`, {
      headers: { accept: "text/html" },
    });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    const body = await html.text();
    expect(body).toContain("innies.live / invite landing");
    expect(body).toContain("Paste this invite into an existing Claude Code or Codex session");
    expect(body).toContain("This browser cannot join the room");
    expect(body).not.toContain("Send message");
  });

});
