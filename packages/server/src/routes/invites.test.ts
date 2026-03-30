import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createFakeAgentMeetsStore, type AgentMeetsStore } from "../db/index.js";
import { inviteRoutes } from "./invites.js";

let store: AgentMeetsStore;
let app: Hono;

beforeEach(() => {
  store = createFakeAgentMeetsStore();
  app = new Hono();
  app.route("/", inviteRoutes(store));
});

describe("GET /j/:inviteToken", () => {
  test("returns manifest with room stem and invite role", async () => {
    await store.createRoom({
      id: "ABC123",
      hostToken: "host-token",
      openingMessage: "Opening hello",
      roomStem: "r_9wK3mQvH8",
    });
    await store.createInvite("ABC123", "r_9wK3mQvH8.1", "2099-03-24 12:05:00");

    const res = await app.request("/j/r_9wK3mQvH8.1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roomId: "ABC123",
      roomStem: "r_9wK3mQvH8",
      role: "host",
      status: "waiting_for_both",
      openingMessage: "Opening hello",
      expiresAt: "2099-03-24 12:05:00",
    });
  });

  test("returns a thin informational landing for browsers requesting html", async () => {
    await store.createRoom({
      id: "ABC123",
      hostToken: "host-token",
      openingMessage: "Opening hello",
      roomStem: "r_9wK3mQvH8",
    });
    await store.createInvite("ABC123", "r_9wK3mQvH8.1", "2099-03-24 12:05:00");

    const res = await app.request("/j/r_9wK3mQvH8.1", {
      headers: { accept: "text/html" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("innies.live / invite landing");
    expect(html).not.toContain("agentmeets / invite landing");
    expect(html).toContain("Paste this invite into an existing Claude Code or Codex session");
    expect(html).toContain("This browser cannot join the room");
    expect(html).not.toContain("Send message");
  });
});

describe("POST /invites/:inviteToken/claim", () => {
  test("requires Idempotency-Key", async () => {
    await store.createRoom({
      id: "ABC123",
      hostToken: "host-token",
      openingMessage: "Opening hello",
      roomStem: "r_9wK3mQvH8",
    });
    await store.createInvite("ABC123", "r_9wK3mQvH8.2", "2099-03-24 12:05:00");

    const res = await app.request("/invites/r_9wK3mQvH8.2/claim", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_idempotency_key" });
  });

  test("returns waiting_for_both for a guest claim and is idempotent for the same key", async () => {
    await store.createRoom({
      id: "ABC123",
      hostToken: "host-token",
      openingMessage: "Opening hello",
      roomStem: "r_9wK3mQvH8",
    });
    await store.createInvite("ABC123", "r_9wK3mQvH8.2", "2099-03-24 12:05:00");

    const first = await app.request("/invites/r_9wK3mQvH8.2/claim", {
      method: "POST",
      headers: { "Idempotency-Key": "claim-1" },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toEqual({
      roomId: "ABC123",
      role: "guest",
      sessionToken: expect.any(String),
      status: "waiting_for_both",
    });

    const repeat = await app.request("/invites/r_9wK3mQvH8.2/claim", {
      method: "POST",
      headers: { "Idempotency-Key": "claim-1" },
    });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(firstBody);
  });

  test("conflicts when a different idempotency key claims an already-claimed invite", async () => {
    await store.createRoom({
      id: "ABC123",
      hostToken: "host-token",
      openingMessage: "Opening hello",
      roomStem: "r_9wK3mQvH8",
    });
    await store.createInvite("ABC123", "r_9wK3mQvH8.2", "2099-03-24 12:05:00");

    await app.request("/invites/r_9wK3mQvH8.2/claim", {
      method: "POST",
      headers: { "Idempotency-Key": "claim-1" },
    });

    const conflict = await app.request("/invites/r_9wK3mQvH8.2/claim", {
      method: "POST",
      headers: { "Idempotency-Key": "claim-2" },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "invite_already_claimed" });
  });
});
