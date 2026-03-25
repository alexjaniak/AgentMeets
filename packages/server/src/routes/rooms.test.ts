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
  test("returns 201 with roomId and hostToken", async () => {
    const res = await app.request("/rooms", { method: "POST" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.roomId).toMatch(/^[A-Z0-9]{6}$/);
    expect(body.hostToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("creates room in database", async () => {
    const res = await app.request("/rooms", { method: "POST" });
    const body = await res.json();
    const stmt = db.prepare("SELECT * FROM rooms WHERE id = ?");
    const room = stmt.get(body.roomId) as { id: string; status: string };
    expect(room).not.toBeNull();
    expect(room.status).toBe("waiting");
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
