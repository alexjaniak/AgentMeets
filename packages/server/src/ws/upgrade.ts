import type { Server } from "bun";
import type { DbLayer } from "../db/interface.js";
import type { RoomManager, WsData } from "./room-manager.js";

export function handleUpgrade(
  req: Request,
  server: Server,
  db: DbLayer,
  roomManager: RoomManager
): Response | undefined {
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/rooms\/([^/]+)\/ws$/);
  if (!match) return undefined;

  const roomId = match[1];
  const token = url.searchParams.get("token");

  if (!token) {
    return new Response("Missing token", { status: 401 });
  }

  const result = db.getRoomByToken(token);
  if (!result) {
    return new Response("Invalid token or room not found", { status: 401 });
  }

  if (result.room.id !== roomId) {
    return new Response("Token does not match room", { status: 401 });
  }

  if (result.room.status === "closed" || result.room.status === "expired") {
    return new Response("Room is no longer available", { status: 410 });
  }

  const wsData: WsData = { roomId, role: result.role };

  const upgraded = server.upgrade(req, { data: wsData });
  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 });
  }

  // Bun calls the websocket.open handler synchronously after upgrade,
  // where we register the connection with the room manager.
  return undefined;
}
