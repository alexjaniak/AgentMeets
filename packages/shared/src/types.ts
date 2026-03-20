export type RoomStatus = "waiting" | "active" | "closed" | "expired";

export type CloseReason = "closed" | "timeout" | "idle";

export type Sender = "host" | "guest";

export interface Room {
  id: string;
  host_token: string;
  guest_token: string | null;
  status: RoomStatus;
  created_at: string;
  joined_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
}

export interface Message {
  id: number;
  room_id: string;
  sender: Sender;
  content: string;
  created_at: string;
}
