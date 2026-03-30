import type { ServerWebSocket } from "bun";
import type { ClientMessage, ErrorCode, MessagePayload } from "@agentmeets/shared";
import type { RoomManager, WsData } from "./room-manager.js";

export function createWebSocketHandlers(roomManager: RoomManager) {
  return {
    open(ws: ServerWebSocket<WsData>) {
      const { roomId, role } = ws.data;
      void roomManager.addConnection(roomId, role, ws).catch((error) => {
        console.error("WebSocket open failed", error);
        ws.close(1011, "Connection failed");
      });
    },

    message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
      const { roomId, role } = ws.data;
      const text = typeof raw === "string" ? raw : raw.toString();

      let msg: ClientMessage;
      try {
        msg = JSON.parse(text);
      } catch {
        sendProtocolError(ws, "invalid_json", "Invalid JSON");
        return;
      }

      if (msg.type === "message") {
        const validationError = validateMessagePayload(msg);
        if (validationError) {
          sendProtocolError(ws, "invalid_message", validationError);
          return;
        }

        void roomManager.handleMessage(roomId, role, {
          clientMessageId: msg.clientMessageId,
          replyToMessageId: msg.replyToMessageId,
          content: msg.content,
        }).then((ok) => {
          if (!ok) {
            ws.close(1009, "Message too large");
          }
        }).catch((error) => {
          console.error("WebSocket message failed", error);
          ws.close(1011, "Message handling failed");
        });
      } else if (msg.type === "end") {
        void roomManager.handleEnd(roomId, role).catch((error) => {
          console.error("WebSocket end failed", error);
          ws.close(1011, "End handling failed");
        });
      } else {
        sendProtocolError(ws, "unknown_message_type", "Unknown message type");
      }
    },

    close(ws: ServerWebSocket<WsData>, code: number, reason: string) {
      const { roomId, role } = ws.data;
      if (roomManager.hasRoom(roomId) && roomManager.getConnection(roomId, role) === ws) {
        roomManager.removeConnection(roomId, role);
        void roomManager.handleDisconnect(roomId, role).catch((error) => {
          console.error("WebSocket disconnect failed", error);
        });
      }
    },
  };
}

function validateMessagePayload(msg: MessagePayload): string | null {
  if (typeof msg.clientMessageId !== "string" || msg.clientMessageId.length === 0) {
    return "Invalid message: clientMessageId must be a non-empty string";
  }

  if (!Object.hasOwn(msg, "replyToMessageId")) {
    return "Invalid message: replyToMessageId must be present and be an integer or null";
  }

  if (msg.replyToMessageId !== null) {
    if (typeof msg.replyToMessageId !== "number" || !Number.isInteger(msg.replyToMessageId)) {
      return "Invalid message: replyToMessageId must be present and be an integer or null";
    }
  }

  if (typeof msg.content !== "string") {
    return "Invalid message: content must be a string";
  }

  return null;
}

function sendProtocolError(
  ws: ServerWebSocket<WsData>,
  code: ErrorCode,
  message: string,
): void {
  ws.send(JSON.stringify({ type: "error", code, message }));
}
