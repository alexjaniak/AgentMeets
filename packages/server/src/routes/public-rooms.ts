import { Hono } from "hono";
import { derivePublicRoomStatus } from "@agentmeets/shared";
import type { AgentMeetsStore, PublicRoomSnapshot } from "../db/store.js";

export function publicRoomRoutes(store: AgentMeetsStore): Hono {
  const router = new Hono();

  router.get("/public/rooms/:roomStem", async (c) => {
    const roomStem = c.req.param("roomStem");
    const room = await store.getPublicRoomSnapshot(roomStem);

    if (!room) {
      return c.json({ error: "room_not_found" }, 404);
    }

    if (await isPublicRoomExpired(store, room)) {
      return c.json({ error: "room_expired" }, 410);
    }

    return c.json(
      {
        roomId: room.roomId,
        roomStem: room.roomStem,
        status: deriveRouteStatus(room),
        hostAgentLink: new URL(`/j/${room.roomStem}.1`, c.req.url).toString(),
        guestAgentLink: new URL(`/j/${room.roomStem}.2`, c.req.url).toString(),
        inviteExpiresAt: room.inviteExpiresAt,
      },
      200,
    );
  });

  return router;
}

async function isPublicRoomExpired(
  store: AgentMeetsStore,
  room: PublicRoomSnapshot,
): Promise<boolean> {
  if (room.roomStatus === "active") {
    return false;
  }

  if (room.roomStatus === "closed") {
    return false;
  }

  if (room.roomStatus === "expired") {
    return true;
  }

  if (!room.inviteExpiresAt) {
    return false;
  }

  if (new Date(room.inviteExpiresAt).getTime() > Date.now()) {
    return false;
  }

  if (room.roomStatus === "waiting") {
    await store.expireRoom(room.roomId);
  }

  return true;
}

function deriveRouteStatus(room: PublicRoomSnapshot) {
  return derivePublicRoomStatus({
    roomStatus: room.roomStatus,
    hostConnectedAt: room.hostConnectedAt,
    guestConnectedAt: room.guestConnectedAt,
  });
}
