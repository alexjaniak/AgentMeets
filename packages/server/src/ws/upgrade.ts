import type { Server } from "bun";
import type { AgentMeetsStore } from "../db/store.js";
import type { RoomManager, WsData } from "./room-manager.js";

export async function handleUpgrade(
  req: Request,
  server: Server<WsData>,
  store: AgentMeetsStore,
  roomManager: RoomManager,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/rooms\/([^/]+)\/ws$/);
  if (!match) return undefined;

  const roomId = match[1];
  const token = url.searchParams.get("token");

  if (!token) {
    return new Response("Missing token", { status: 401 });
  }

  const result = await store.getRoomByToken(token);
  if (!result) {
    return new Response("Invalid token or room not found", { status: 401 });
  }

  if (result.room.id !== roomId) {
    return new Response("Token does not match room", { status: 401 });
  }

  await roomManager.expireIdleRoomIfNeeded(roomId);
  const refreshedResult = await store.getRoomByToken(token);
  if (!refreshedResult) {
    return new Response("Invalid token or room not found", { status: 401 });
  }

  if (
    refreshedResult.room.status === "closed"
    || refreshedResult.room.status === "expired"
  ) {
    return new Response("Room is no longer available", { status: 410 });
  }

  if (roomManager.getConnection(refreshedResult.room.id, refreshedResult.role)) {
    return new Response("Role already connected", { status: 409 });
  }

  const wsData: WsData = { roomId, role: refreshedResult.role };

  const upgraded = server.upgrade(req, { data: wsData });
  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  return undefined;
}
