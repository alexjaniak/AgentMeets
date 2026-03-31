export type RoomStatus =
  | "waiting_for_join"
  | "activating"
  | "active"
  | "ended"
  | "expired";

export type StoredRoomStatus = "waiting" | "active" | "closed" | "expired";

export type CloseReason =
  | "user_ended"
  | "disconnected"
  | "timeout"
  | "expired"
  | "join_failed";

export type StoredCloseReason =
  | "closed"
  | "timeout"
  | "idle"
  | "user_ended"
  | "disconnected"
  | "expired"
  | "join_failed";

export type Sender = "host" | "guest";

export interface Room {
  id: string;
  room_stem: string | null;
  host_token: string;
  guest_token: string | null;
  status: RoomStatus;
  opening_message_id?: number | null;
  created_at: string;
  last_activity_at?: string | null;
  joined_at: string | null;
  closed_at: string | null;
  close_reason: CloseReason | null;
}

export interface StoredRoom {
  id: string;
  room_stem: string | null;
  host_token: string;
  guest_token: string | null;
  status: StoredRoomStatus;
  opening_message_id?: number | null;
  created_at: string;
  last_activity_at?: string | null;
  joined_at: string | null;
  closed_at: string | null;
  close_reason: StoredCloseReason | null;
}

export interface Message {
  id: number;
  room_id: string;
  sender: Sender;
  content: string;
  created_at: string;
}
