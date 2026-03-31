import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { initializeSchema } from "../db/schema.js";
import { createInvite } from "../db/invites.js";
import { closeRoom, createRoom, expireRoom, joinRoom } from "../db/rooms.js";
import { publicRoomRoutes } from "./public-rooms.js";

let db: Database;
let app: Hono;

beforeEach(() => {
  db = new Database(":memory:");
  initializeSchema(db);
  app = new Hono();
  app.route("/", publicRoomRoutes(db));
});

describe("GET /public/rooms/:roomStem", () => {
  test("returns browser-safe room instructions while the room is still joinable", async () => {
    createRoom(
      db,
      "ROOM01",
      "host-token-123",
      "Can you inspect auth?",
      "r_9wK3mQvH8",
    );
    createInvite(db, "ROOM01", "r_9wK3mQvH8.1", "2099-03-24 12:05:00");
    createInvite(db, "ROOM01", "r_9wK3mQvH8.2", "2099-03-24 12:05:00");

    const res = await app.request("/public/rooms/r_9wK3mQvH8");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roomId: "ROOM01",
      roomStem: "r_9wK3mQvH8",
      status: "waiting_for_join",
      hostAgentLink: expect.stringMatching(/\/j\/r_9wK3mQvH8\.1$/),
      guestAgentLink: expect.stringMatching(/\/j\/r_9wK3mQvH8\.2$/),
      inviteExpiresAt: "2099-03-24 12:05:00",
    });
  });

  test("returns 410 after the room expires", async () => {
    createRoom(
      db,
      "ROOM01",
      "host-token-123",
      "Can you inspect auth?",
      "r_9wK3mQvH8",
    );
    expireRoom(db, "ROOM01");

    const res = await app.request("/public/rooms/r_9wK3mQvH8");
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "room_expired" });
  });

  test("returns room details while active even after invite expiry", async () => {
    createRoom(
      db,
      "ROOM01",
      "host-token-123",
      "Can you inspect auth?",
      "r_9wK3mQvH8",
    );
    createInvite(db, "ROOM01", "r_9wK3mQvH8.1", "2000-03-24 12:05:00");
    createInvite(db, "ROOM01", "r_9wK3mQvH8.2", "2000-03-24 12:05:00");
    joinRoom(db, "ROOM01", "guest-token-123");

    const res = await app.request("/public/rooms/r_9wK3mQvH8");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roomId: "ROOM01",
      roomStem: "r_9wK3mQvH8",
      status: "active",
      hostAgentLink: expect.stringMatching(/\/j\/r_9wK3mQvH8\.1$/),
      guestAgentLink: expect.stringMatching(/\/j\/r_9wK3mQvH8\.2$/),
      inviteExpiresAt: "2000-03-24 12:05:00",
    });
  });

  test("returns 410 after the room has ended", async () => {
    createRoom(
      db,
      "ROOM01",
      "host-token-123",
      "Can you inspect auth?",
      "r_9wK3mQvH8",
    );
    createInvite(db, "ROOM01", "r_9wK3mQvH8.1", "2099-03-24 12:05:00");
    createInvite(db, "ROOM01", "r_9wK3mQvH8.2", "2099-03-24 12:05:00");
    joinRoom(db, "ROOM01", "guest-token-123");
    closeRoom(db, "ROOM01", "closed");

    const res = await app.request("/public/rooms/r_9wK3mQvH8");
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "room_expired" });
  });
});
