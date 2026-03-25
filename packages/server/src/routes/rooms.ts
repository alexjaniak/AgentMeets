import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  createRoom,
  expireRoom,
  getRoom,
  joinRoom,
  issueInvite,
  generateRoomId,
  generateToken,
} from "../db/index.js";
import { rateLimiter } from "../middleware/rate-limit.js";

const ROOM_ID_PATTERN = /^[A-Z0-9]{6}$/;
const MAX_COLLISION_RETRIES = 3;
const DEFAULT_INVITE_TTL_MS = 10 * 60 * 1000;
const ROOM_STEM_PREFIX = "r_";

export function roomRoutes(db: Database): Hono {
  const router = new Hono();
  const createRoomWithInvites = db.transaction(
    (
      roomId: string,
      roomStem: string,
      hostToken: string,
      openingMessage: string,
      inviteExpiresAt: string,
    ) => {
      createRoom(db, roomId, hostToken, openingMessage, roomStem);
      issueInvite(db, roomId, `${roomStem}.1`, inviteExpiresAt);
      issueInvite(db, roomId, `${roomStem}.2`, inviteExpiresAt);
    },
  );

  router.post("/rooms", async (c) => {
    let body: { openingMessage?: unknown; inviteTtlSeconds?: unknown };
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const openingMessage =
      typeof body.openingMessage === "string" ? body.openingMessage.trim() : "";
    if (openingMessage.length === 0) {
      return c.json({ error: "invalid_opening_message" }, 400);
    }

    if (
      body.inviteTtlSeconds !== undefined &&
      (typeof body.inviteTtlSeconds !== "number" ||
        !Number.isInteger(body.inviteTtlSeconds) ||
        body.inviteTtlSeconds <= 0)
    ) {
      return c.json({ error: "invalid_invite_ttl_seconds" }, 400);
    }

    const inviteExpiresAt =
      typeof body.inviteTtlSeconds === "number"
        ? new Date(Date.now() + body.inviteTtlSeconds * 1000).toISOString()
        : new Date(Date.now() + DEFAULT_INVITE_TTL_MS).toISOString();

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
      const roomId = generateRoomId();
      const roomStem = generateRoomStem();
      const hostToken = generateToken();
      try {
        createRoomWithInvites(
          roomId,
          roomStem,
          hostToken,
          openingMessage,
          inviteExpiresAt,
        );
        return c.json(
          {
            roomId,
            roomStem,
            hostAgentLink: new URL(`/j/${roomStem}.1`, c.req.url).toString(),
            guestAgentLink: new URL(`/j/${roomStem}.2`, c.req.url).toString(),
            inviteExpiresAt,
            status: "waiting_for_join",
          },
          201,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("UNIQUE constraint failed") || msg.includes("PRIMARY KEY")) {
          lastError = e;
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  });

  const joinRateLimit = rateLimiter(10, 60_000);

  router.post("/rooms/:id/join", joinRateLimit, async (c) => {
    const id = c.req.param("id");

    if (!ROOM_ID_PATTERN.test(id)) {
      return c.json({ error: "invalid_room_id" }, 400);
    }

    const room = getRoom(db, id);
    if (!room) {
      return c.json({ error: "room_not_found" }, 404);
    }
    if (room.status === "expired" || room.status === "closed") {
      return c.json({ error: "room_expired" }, 410);
    }
    if (room.guest_token !== null) {
      return c.json({ error: "room_full" }, 409);
    }
    if (hasInviteExpired(db, id)) {
      expireRoom(db, id);
      return c.json({ error: "room_expired" }, 410);
    }

    const guestToken = generateToken();
    joinRoom(db, id, guestToken);
    return c.json({ guestToken }, 200);
  });

  return router;
}

function generateRoomStem(): string {
  return `${ROOM_STEM_PREFIX}${generateToken().replaceAll("-", "")}`;
}

function hasInviteExpired(db: Database, roomId: string): boolean {
  const row = db
    .prepare(
      `SELECT MIN(expires_at) AS expires_at
       FROM invites
       WHERE room_id = ?`,
    )
    .get(roomId) as { expires_at: string | null } | null;

  if (!row?.expires_at) {
    return false;
  }

  return new Date(row.expires_at).getTime() <= Date.now();
}
