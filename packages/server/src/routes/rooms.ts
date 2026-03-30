import { Hono } from "hono";
import { customAlphabet } from "nanoid";
import type { AgentMeetsStore } from "../db/store.js";
import { generateRoomId, generateToken } from "../db/tokens.js";
import { rateLimiter } from "../middleware/rate-limit.js";

const ROOM_ID_PATTERN = /^[A-Z0-9]{6}$/;
const MAX_COLLISION_RETRIES = 3;
const PUBLIC_BASE_URL =
  process.env.PUBLIC_URL?.replace(/\/$/, "") ?? "https://api.innies.live";
const DEFAULT_INVITE_TTL_MS = 10 * 60 * 1000;

export function roomRoutes(store: AgentMeetsStore): Hono {
  const router = new Hono();

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
    if (openingMessage.length > 10_000) {
      return c.json({ error: "openingMessage exceeds 10,000 character limit" }, 413);
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
        await store.createRoomWithInvites({
          roomId,
          roomStem,
          hostToken,
          openingMessage,
          inviteExpiresAt,
        });
        return c.json(
          {
            roomId,
            roomStem,
            hostAgentLink: `${PUBLIC_BASE_URL}/j/${roomStem}.1`,
            guestAgentLink: `${PUBLIC_BASE_URL}/j/${roomStem}.2`,
            inviteExpiresAt,
            status: "waiting_for_both",
          },
          201,
        );
      } catch (e: unknown) {
        if (isRoomCollisionError(e)) {
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
    const id = c.req.param("id")!;

    if (!ROOM_ID_PATTERN.test(id)) {
      return c.json({ error: "invalid_room_id" }, 400);
    }

    const room = await store.getRoom(id);
    if (!room) {
      return c.json({ error: "room_not_found" }, 404);
    }
    if (room.status === "expired" || room.status === "closed") {
      return c.json({ error: "room_expired" }, 410);
    }
    if (room.guest_token !== null) {
      return c.json({ error: "room_full" }, 409);
    }
    if (await hasInviteExpired(store, room.id, room.room_stem)) {
      await store.expireRoom(id);
      return c.json({ error: "room_expired" }, 410);
    }

    const guestToken = generateToken();
    try {
      await store.joinRoom(id, guestToken);
    } catch (error) {
      const joinError = error instanceof Error ? error.message : String(error);
      if (joinError === "Room not found") {
        return c.json({ error: "room_not_found" }, 404);
      }
      if (joinError === "Room is full" || joinError === "Room join conflict") {
        return c.json({ error: "room_full" }, 409);
      }
      if (joinError === "Room is expired" || joinError === "Room is closed") {
        return c.json({ error: "room_expired" }, 410);
      }
      throw error;
    }
    return c.json({ guestToken }, 200);
  });

  return router;
}

const stemAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const generateStemId = customAlphabet(stemAlphabet, 10);

function generateRoomStem(): string {
  return generateStemId();
}

async function hasInviteExpired(
  store: AgentMeetsStore,
  roomId: string,
  roomStem: string | null,
): Promise<boolean> {
  if (!roomStem) {
    return false;
  }

  const snapshot = await store.getPublicRoomSnapshot(roomStem);
  if (!snapshot || snapshot.roomId !== roomId || !snapshot.inviteExpiresAt) {
    return false;
  }

  return new Date(snapshot.inviteExpiresAt).getTime() <= Date.now();
}

function isRoomCollisionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("UNIQUE constraint failed")
    || msg.includes("PRIMARY KEY")
    || msg.includes("duplicate room id")
    || msg.includes("duplicate room stem")
    || msg.includes("duplicate key value violates unique constraint");
}
