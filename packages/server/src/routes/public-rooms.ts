import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { RoomStatus } from "@agentmeets/shared";
import { expireRoom } from "../db/rooms.js";

interface PublicRoomRow {
  room_id: string;
  room_stem: string;
  room_status: "waiting" | "active" | "closed" | "expired";
  guest_token: string | null;
  invite_expires_at: string | null;
  has_claimed_invite: number;
}

export function publicRoomRoutes(db: Database): Hono {
  const router = new Hono();

  router.get("/public/rooms/:roomStem", (c) => {
    const roomStem = c.req.param("roomStem");
    const room = getPublicRoomRow(db, roomStem);

    if (!room) {
      return c.json({ error: "room_not_found" }, 404);
    }

    if (isPublicRoomExpired(db, room)) {
      return c.json({ error: "room_expired" }, 410);
    }

    return c.json(
      {
        roomId: room.room_id,
        roomStem: room.room_stem,
        status: derivePublicRoomStatus(room),
        hostAgentLink: new URL(`/j/${room.room_stem}.1`, c.req.url).toString(),
        guestAgentLink: new URL(`/j/${room.room_stem}.2`, c.req.url).toString(),
        inviteExpiresAt: room.invite_expires_at,
      },
      200,
    );
  });

  return router;
}

function getPublicRoomRow(
  db: Database,
  roomStem: string,
): PublicRoomRow | null {
  const row = db
    .prepare(
      `SELECT
         r.id AS room_id,
         r.room_stem,
         r.status AS room_status,
         r.guest_token,
         MIN(i.expires_at) AS invite_expires_at,
         MAX(CASE WHEN i.claimed_at IS NOT NULL THEN 1 ELSE 0 END) AS has_claimed_invite
       FROM rooms r
       LEFT JOIN invites i ON i.room_id = r.id
       WHERE r.room_stem = ?
       GROUP BY r.id, r.room_stem, r.status, r.guest_token`,
    )
    .get(roomStem) as PublicRoomRow | null;

  return row ?? null;
}

function isPublicRoomExpired(db: Database, room: PublicRoomRow): boolean {
  if (room.room_status === "active") {
    return false;
  }

  if (room.room_status === "closed" || room.room_status === "expired") {
    return true;
  }

  if (!room.invite_expires_at) {
    return false;
  }

  if (new Date(room.invite_expires_at).getTime() > Date.now()) {
    return false;
  }

  if (room.room_status === "waiting" && room.guest_token === null) {
    expireRoom(db, room.room_id);
  }

  return true;
}

function derivePublicRoomStatus(room: PublicRoomRow): RoomStatus {
  if (room.room_status === "active") {
    return "active";
  }

  if (room.room_status === "closed") {
    return "ended";
  }

  if (room.room_status === "expired") {
    return "expired";
  }

  if (room.guest_token !== null || room.has_claimed_invite > 0) {
    return "activating";
  }

  return "waiting_for_join";
}
