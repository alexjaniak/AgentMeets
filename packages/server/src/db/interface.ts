import type { CloseReason, Role, Room } from "../types.js";

export interface DbLayer {
  getRoomByToken(token: string): { room: Room; role: Role } | null;
  closeRoom(roomId: string, reason: CloseReason): void;
  activateRoom(roomId: string): void;
  saveMessage(roomId: string, sender: Role, content: string): void;
}
