import type { CloseReason, Sender } from "./types.js";

// Client → Server messages

export interface MessagePayload {
  type: "message";
  clientMessageId: string;
  replyToMessageId: number | null;
  content: string;
}

export interface EndPayload {
  type: "end";
}

export type ClientMessage = MessagePayload | EndPayload;

// Server → Client messages

export interface RoomActiveEvent {
  type: "room_active";
}

export interface MessageEvent {
  type: "message";
  messageId: number;
  sender: Sender;
  clientMessageId: string;
  replyToMessageId: number | null;
  content: string;
  createdAt: string;
}

export interface AckEvent {
  type: "ack";
  messageId: number;
  clientMessageId: string;
  replyToMessageId: number | null;
  createdAt: string;
}

export type ErrorCode =
  | "invalid_json"
  | "unknown_message_type"
  | "invalid_message";

export interface ErrorEvent {
  type: "error";
  code: ErrorCode;
  message: string;
}

export interface EndedEvent {
  type: "ended";
  reason: CloseReason;
}

export type ServerMessage =
  | RoomActiveEvent
  | MessageEvent
  | AckEvent
  | ErrorEvent
  | EndedEvent;
