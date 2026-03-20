import type { ServerWebSocket } from "bun";
import type { ClientMessage } from "@agentmeets/shared";
import type { RoomManager, WsData } from "./room-manager.js";

export function createWebSocketHandlers(roomManager: RoomManager) {
  return {
    open(ws: ServerWebSocket<WsData>) {
      const { roomId, role } = ws.data;
      roomManager.addConnection(roomId, role, ws);
    },

    message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
      const { roomId, role } = ws.data;
      const text = typeof raw === "string" ? raw : raw.toString();

      let msg: ClientMessage;
      try {
        msg = JSON.parse(text);
      } catch {
        ws.close(1008, "Invalid JSON");
        return;
      }

      if (msg.type === "message") {
        if (typeof msg.content !== "string") {
          ws.close(1008, "Invalid message: content must be a string");
          return;
        }
        const ok = roomManager.handleMessage(roomId, role, msg.content);
        if (!ok) {
          ws.close(1009, "Message too large");
        }
      } else if (msg.type === "end") {
        roomManager.handleEnd(roomId, role);
      } else {
        ws.close(1008, "Unknown message type");
      }
    },

    close(ws: ServerWebSocket<WsData>, code: number, reason: string) {
      const { roomId, role } = ws.data;
      if (roomManager.hasRoom(roomId) && roomManager.getConnection(roomId, role) === ws) {
        roomManager.removeConnection(roomId, role);
        roomManager.handleDisconnect(roomId, role);
      }
    },
  };
}
