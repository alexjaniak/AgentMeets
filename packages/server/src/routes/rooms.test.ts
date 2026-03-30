import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createFakeAgentMeetsStore, type AgentMeetsStore } from "../db/index.js";
import { roomRoutes } from "./rooms.js";

let store: AgentMeetsStore;
let app: Hono;

beforeEach(() => {
  store = createFakeAgentMeetsStore();
  app = new Hono();
  app.route("/", roomRoutes(store));
});

describe("POST /rooms", () => {
  test("returns 400 when openingMessage is missing", async () => {
    const res = await app.request("/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_opening_message");
  });

  test("returns 400 when openingMessage is blank", async () => {
    const res = await app.request("/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingMessage: "   " }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_opening_message");
  });

  test("returns 201 with paired participant links from the same room stem", async () => {
    const res = await app.request("http://agentmeets.test/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingMessage: "Opening hello" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      roomId: expect.stringMatching(/^[A-Z0-9]{6}$/),
      roomStem: expect.stringMatching(/^[A-Za-z0-9]{10}$/),
      hostAgentLink: expect.stringMatching(
        /\/j\/[A-Za-z0-9]{10}\.1$/,
      ),
      guestAgentLink: expect.stringMatching(
        /\/j\/[A-Za-z0-9]{10}\.2$/,
      ),
      inviteExpiresAt: expect.any(String),
      status: "waiting_for_both",
    });
  });

  test("creates room with the opening message persisted as the first host message", async () => {
    const res = await app.request("/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ openingMessage: "Opening hello" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    const room = await store.getRoom(body.roomId);
    expect(room).not.toBeNull();
    expect(room!.status).toBe("waiting");

    const messages = await store.getMessages(body.roomId);
    expect(messages).toEqual([
      {
        id: room!.opening_message_id!,
        sender: "host",
        room_id: body.roomId,
        content: "Opening hello",
        created_at: expect.any(String),
      },
    ]);
  });

  test("uses inviteTtlSeconds when issuing the invite", async () => {
    const before = Date.now();
    const res = await app.request("/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        openingMessage: "Opening hello",
        inviteTtlSeconds: 900,
      }),
    });
    const after = Date.now();

    expect(res.status).toBe(201);
    const body = await res.json();
    const guestInvite = await store.getInviteManifest(`${body.roomStem}.2`);
    const hostInvite = await store.getInviteManifest(`${body.roomStem}.1`);
    const invites = [
      { participant_role: "guest", expires_at: guestInvite.expiresAt },
      { participant_role: "host", expires_at: hostInvite.expiresAt },
    ];

    expect(invites).toHaveLength(2);
    expect(invites[0].participant_role).toBe("guest");
    expect(invites[1].participant_role).toBe("host");
    expect(new Date(invites[0].expires_at).getTime()).toBeGreaterThanOrEqual(
      before + 900_000,
    );
    expect(new Date(invites[1].expires_at).getTime()).toBeLessThanOrEqual(
      after + 900_000,
    );
  });

  test("returns 400 when inviteTtlSeconds is invalid", async () => {
    const res = await app.request("/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        openingMessage: "Opening hello",
        inviteTtlSeconds: 0,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_invite_ttl_seconds");
  });
});

describe("POST /rooms/:id/join", () => {
  test("returns 200 with guestToken for a waiting room", async () => {
    await store.createRoom({ id: "ABC123", hostToken: "host-token" });
    const res = await app.request("/rooms/ABC123/join", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.guestToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("returns 404 for nonexistent room", async () => {
    const res = await app.request("/rooms/NOPE00/join", { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("room_not_found");
  });

  test("returns 409 for room that already has a guest", async () => {
    await store.createRoom({ id: "ABC123", hostToken: "host-token" });
    await store.joinRoom("ABC123", "guest-token-1");
    const res = await app.request("/rooms/ABC123/join", { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("room_full");
  });

  test("returns 410 for expired room", async () => {
    await store.createRoom({ id: "ABC123", hostToken: "host-token" });
    await store.expireRoom("ABC123");
    const res = await app.request("/rooms/ABC123/join", { method: "POST" });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe("room_expired");
  });

  test("returns 410 for closed room", async () => {
    await store.createRoom({ id: "ABC123", hostToken: "host-token" });
    await store.joinRoom("ABC123", "guest-token-1");
    await store.closeRoom("ABC123", "closed");
    const res = await app.request("/rooms/ABC123/join", { method: "POST" });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe("room_expired");
  });

  test("returns 409 when join loses a concurrent race after the route precheck", async () => {
    await store.createRoom({ id: "ABC123", hostToken: "host-token" });
    store.joinRoom = async () => {
      throw new Error("Room is full");
    };

    const res = await app.request("/rooms/ABC123/join", { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("room_full");
  });

  test("returns 400 for malformed room ID (too short)", async () => {
    const res = await app.request("/rooms/ABC/join", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_room_id");
  });

  test("returns 400 for malformed room ID (lowercase)", async () => {
    const res = await app.request("/rooms/abc123/join", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_room_id");
  });

  test("returns 400 for malformed room ID (special chars)", async () => {
    const res = await app.request("/rooms/AB-1!3/join", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_room_id");
  });

  test("rate limits excessive join attempts", async () => {
    await store.createRoom({ id: "ABC123", hostToken: "host-token" });

    // First 10 attempts should not be rate limited (room will be full after 1st)
    for (let i = 0; i < 10; i++) {
      const res = await app.request("/rooms/ABC123/join", {
        method: "POST",
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
      // First succeeds, rest get 409 (full), but none should be 429
      expect(res.status).not.toBe(429);
    }

    // 11th attempt should be rate limited
    const res = await app.request("/rooms/ABC123/join", {
      method: "POST",
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("rate_limit_exceeded");
  });

  test("rate limit is per-IP", async () => {
    await store.createRoom({ id: "ABC123", hostToken: "host-token" });

    // Exhaust rate limit for IP 1.2.3.4
    for (let i = 0; i < 11; i++) {
      await app.request("/rooms/ABC123/join", {
        method: "POST",
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
    }

    // Different IP should still work
    const res = await app.request("/rooms/ABC123/join", {
      method: "POST",
      headers: { "x-forwarded-for": "5.6.7.8" },
    });
    expect(res.status).not.toBe(429);
  });
});
