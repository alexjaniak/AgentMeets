import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { initializeSchema } from "../db/schema.js";
import { createRoom, joinRoom, expireRoom, closeRoom } from "../db/rooms.js";
import { roomRoutes } from "./rooms.js";

let db: Database;
let app: Hono;

beforeEach(() => {
  db = new Database(":memory:");
  initializeSchema(db);
  app = new Hono();
  app.route("/", roomRoutes(db));
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
      roomStem: expect.stringMatching(/^r_[A-Za-z0-9_-]+$/),
      hostAgentLink: expect.stringMatching(
        /^http:\/\/agentmeets\.test\/j\/r_[A-Za-z0-9_-]+\.1$/,
      ),
      guestAgentLink: expect.stringMatching(
        /^http:\/\/agentmeets\.test\/j\/r_[A-Za-z0-9_-]+\.2$/,
      ),
      inviteExpiresAt: expect.any(String),
      status: "waiting_for_join",
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
    const room = db
      .prepare("SELECT id, status, opening_message_id FROM rooms WHERE id = ?")
      .get(body.roomId) as {
      id: string;
      status: string;
      opening_message_id: number | null;
    };
    expect(room).not.toBeNull();
    expect(room.status).toBe("waiting");

    const messages = db
      .prepare("SELECT id, sender, content FROM messages WHERE room_id = ? ORDER BY id ASC")
      .all(body.roomId) as Array<{ id: number; sender: string; content: string }>;
    expect(messages).toEqual([
      {
        id: room.opening_message_id!,
        sender: "host",
        content: "Opening hello",
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
    const invites = db
      .prepare("SELECT participant_role, expires_at FROM invites WHERE room_id = ? ORDER BY participant_role ASC")
      .all(body.roomId) as Array<{ participant_role: string; expires_at: string }>;

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
    createRoom(db, "ABC123", "host-token");
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
    createRoom(db, "ABC123", "host-token");
    joinRoom(db, "ABC123", "guest-token-1");
    const res = await app.request("/rooms/ABC123/join", { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("room_full");
  });

  test("returns 410 for expired room", async () => {
    createRoom(db, "ABC123", "host-token");
    expireRoom(db, "ABC123");
    const res = await app.request("/rooms/ABC123/join", { method: "POST" });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe("room_expired");
  });

  test("returns 410 for closed room", async () => {
    createRoom(db, "ABC123", "host-token");
    joinRoom(db, "ABC123", "guest-token-1");
    closeRoom(db, "ABC123", "closed");
    const res = await app.request("/rooms/ABC123/join", { method: "POST" });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe("room_expired");
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
    createRoom(db, "ABC123", "host-token");

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
    createRoom(db, "ABC123", "host-token");

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
