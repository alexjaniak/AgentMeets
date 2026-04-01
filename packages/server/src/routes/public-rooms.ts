import { Hono } from "hono";
import { derivePublicRoomStatus } from "@agentmeets/shared";
import type { AgentMeetsStore, PublicRoomSnapshot } from "../db/store.js";
import { buildInviteUrl } from "./public-base-url.js";

export function publicRoomRoutes(store: AgentMeetsStore): Hono {
  const router = new Hono();

  router.get("/public/rooms/:roomStem", async (c) => {
    const roomStem = c.req.param("roomStem");
    const room = await store.getPublicRoomSnapshot(roomStem);

    if (!room) {
      return c.json({ error: "room_not_found" }, 404);
    }

    if (room.roomStatus === "expired") {
      return c.json({ error: "room_expired" }, 410);
    }

    return c.json(
      {
        roomId: room.roomId,
        roomStem: room.roomStem,
        status: deriveRouteStatus(room),
        hostAgentLink: buildInviteUrl(`${room.roomStem}.1`),
        guestAgentLink: buildInviteUrl(`${room.roomStem}.2`),
        inviteExpiresAt: room.inviteExpiresAt,
      },
      200,
    );
  });

  return router;
}

function deriveRouteStatus(room: PublicRoomSnapshot) {
  if (room.roomStatus === "closed" || room.roomStatus === "expired") {
    return derivePublicRoomStatus({
      roomStatus: room.roomStatus,
      hostConnectedAt: room.hostConnectedAt,
      guestConnectedAt: room.guestConnectedAt,
    });
  }

  if (room.hostConnectedAt && room.guestConnectedAt) {
    return "active";
  }
  if (room.hostConnectedAt) {
    return "waiting_for_guest";
  }
  if (room.guestConnectedAt) {
    return "waiting_for_host";
  }

  return "waiting_for_both";
}
