import type {
  ClientMessage,
  CloseReason,
  ErrorCode,
  MessagePayload,
  ServerMessage,
  Sender,
} from "@agentmeets/shared";

export interface PendingReplyResult {
  content: string | null;
  reason?: CloseReason | "timeout" | "disconnected";
  error?: {
    code: ErrorCode;
    message: string;
  };
}

export interface MeetState {
  roomId: string;
  token: string;
  role: Sender;
  ws: WebSocket | null;
  collectingPending: string[] | null;
  pendingReply: {
    resolve: (result: PendingReplyResult) => void;
  } | null;
  isRoomActive: boolean;
  lastReceivedMessageId: number | null;
  lastAckedMessageId: number | null;
  pendingClientMessageId: string | null;
}

export type ProcessedServerEvent =
  | { kind: "none" }
  | { kind: "message"; content: string }
  | { kind: "ended"; reason: CloseReason }
  | { kind: "error"; code: ErrorCode; message: string };

export function createMeetState(
  roomId: string,
  token: string,
  role: Sender,
  ws: WebSocket | null,
  collectingPending: string[] | null = null,
): MeetState {
  return {
    roomId,
    token,
    role,
    ws,
    collectingPending,
    pendingReply: null,
    isRoomActive: false,
    lastReceivedMessageId: null,
    lastAckedMessageId: null,
    pendingClientMessageId: null,
  };
}

export function createMessagePayload(
  state: MeetState,
  content: string,
): MessagePayload {
  const payload: MessagePayload = {
    type: "message",
    clientMessageId: crypto.randomUUID(),
    replyToMessageId: state.lastReceivedMessageId,
    content,
  };

  state.pendingClientMessageId = payload.clientMessageId;
  return payload;
}

export function processServerMessage(
  state: MeetState,
  data: ServerMessage,
): ProcessedServerEvent {
  switch (data.type) {
    case "room_active":
      state.isRoomActive = true;
      return { kind: "none" };
    case "ack":
      if (state.pendingClientMessageId === data.clientMessageId) {
        state.lastAckedMessageId = data.messageId;
        state.pendingClientMessageId = null;
      }
      return { kind: "none" };
    case "message":
      state.lastReceivedMessageId = data.messageId;
      return { kind: "message", content: data.content };
    case "error":
      state.pendingClientMessageId = null;
      return {
        kind: "error",
        code: data.code,
        message: data.message,
      };
    case "ended":
      return { kind: "ended", reason: data.reason };
  }
}

export function createEndPayload(): ClientMessage {
  return { type: "end" };
}
