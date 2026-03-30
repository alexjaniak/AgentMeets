import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createFakeAgentMeetsStore, type AgentMeetsStore } from "../db/index.js";
import { publicRoomRoutes } from "./public-rooms.js";

let store: AgentMeetsStore;
let app: Hono;

beforeEach(() => {
  store = createFakeAgentMeetsStore();
  app = new Hono();
  app.route("/", publicRoomRoutes(store));
});

describe("GET /public/rooms/:roomStem", () => {
  test("returns browser-safe room instructions while the room is still joinable", async () => {
    await store.createRoom({
      id: "ROOM01",
      hostToken: "host-token-123",
      openingMessage: "Can you inspect auth?",
      roomStem: "r_9wK3mQvH8",
    });
    await store.createInvite("ROOM01", "r_9wK3mQvH8.1", "2099-03-24 12:05:00");
    await store.createInvite("ROOM01", "r_9wK3mQvH8.2", "2099-03-24 12:05:00");

    const res = await app.request("/public/rooms/r_9wK3mQvH8");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roomId: "ROOM01",
      roomStem: "r_9wK3mQvH8",
      status: "waiting_for_both",
      hostAgentLink: expect.stringMatching(/\/j\/r_9wK3mQvH8\.1$/),
      guestAgentLink: expect.stringMatching(/\/j\/r_9wK3mQvH8\.2$/),
      inviteExpiresAt: "2099-03-24 12:05:00",
    });
  });

  test("returns 410 after the room expires", async () => {
    await store.createRoom({
      id: "ROOM01",
      hostToken: "host-token-123",
      openingMessage: "Can you inspect auth?",
      roomStem: "r_9wK3mQvH8",
    });
    await store.expireRoom("ROOM01");

    const res = await app.request("/public/rooms/r_9wK3mQvH8");
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "room_expired" });
  });

  test("returns room details while active even after invite expiry", async () => {
    await store.createRoom({
      id: "ROOM01",
      hostToken: "host-token-123",
      openingMessage: "Can you inspect auth?",
      roomStem: "r_9wK3mQvH8",
    });
    await store.createInvite("ROOM01", "r_9wK3mQvH8.1", "2000-03-24 12:05:00");
    await store.createInvite("ROOM01", "r_9wK3mQvH8.2", "2000-03-24 12:05:00");
    await store.joinRoom("ROOM01", "guest-token-123");

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

  test("returns ended status after the room has ended", async () => {
    await store.createRoom({
      id: "ROOM01",
      hostToken: "host-token-123",
      openingMessage: "Can you inspect auth?",
      roomStem: "r_9wK3mQvH8",
    });
    await store.createInvite("ROOM01", "r_9wK3mQvH8.1", "2099-03-24 12:05:00");
    await store.createInvite("ROOM01", "r_9wK3mQvH8.2", "2099-03-24 12:05:00");
    await store.joinRoom("ROOM01", "guest-token-123");
    await store.closeRoom("ROOM01", "closed");

    const res = await app.request("/public/rooms/r_9wK3mQvH8");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roomId: "ROOM01",
      roomStem: "r_9wK3mQvH8",
      status: "ended",
      hostAgentLink: expect.stringMatching(/\/j\/r_9wK3mQvH8\.1$/),
      guestAgentLink: expect.stringMatching(/\/j\/r_9wK3mQvH8\.2$/),
      inviteExpiresAt: "2099-03-24 12:05:00",
    });
  });
});
