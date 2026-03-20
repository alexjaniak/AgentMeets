export type RoomStatus = "waiting" | "active" | "closed" | "expired";
export type CloseReason = "closed" | "timeout" | "idle";
export type Role = "host" | "guest";

export interface Room {
  id: string;
  hostToken: string;
  guestToken: string | null;
  status: RoomStatus;
  createdAt: string;
  joinedAt: string | null;
  closedAt: string | null;
  closeReason: CloseReason | null;
}

// Client → Server messages
export type ClientMessage =
  | { type: "message"; content: string }
  | { type: "end" };

// Server → Client messages
export type ServerMessage =
  | { type: "message"; content: string }
  | { type: "joined" }
  | { type: "ended"; reason: CloseReason };
