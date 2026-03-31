export type SessionSender = "host" | "guest";

export type SessionCloseReason =
  | "user_ended"
  | "disconnected"
  | "timeout"
  | "expired"
  | "join_failed";

export type SessionErrorCode =
  | "invalid_json"
  | "unknown_message_type"
  | "invalid_message";

export type DraftMode = "auto" | "manual";

export interface SessionMessagePayload {
  type: "message";
  clientMessageId: string;
  replyToMessageId: number | null;
  content: string;
}

export interface SessionEndPayload {
  type: "end";
}

export type SessionClientMessage = SessionMessagePayload | SessionEndPayload;

export interface SessionRoomActiveEvent {
  type: "room_active";
}

export interface SessionMessageEvent {
  type: "message";
  messageId: number;
  sender: SessionSender;
  clientMessageId: string;
  replyToMessageId: number | null;
  content: string;
  createdAt: string;
}

export interface SessionAckEvent {
  type: "ack";
  messageId: number;
  clientMessageId: string;
  replyToMessageId: number | null;
  createdAt: string;
}

export interface SessionErrorEvent {
  type: "error";
  code: SessionErrorCode;
  message: string;
}

export interface SessionEndedEvent {
  type: "ended";
  reason: SessionCloseReason;
}

export type SessionServerMessage =
  | SessionRoomActiveEvent
  | SessionMessageEvent
  | SessionAckEvent
  | SessionErrorEvent
  | SessionEndedEvent;

export type CountdownResult =
  | { kind: "interrupted"; key: "e" }
  | { kind: "expired"; durationMs: number };

export type TerminalState =
  | { kind: "error"; code: SessionErrorCode; message: string }
  | { kind: "ended"; reason: SessionCloseReason };

export interface SessionHelperState {
  roomId: string;
  draftMode: DraftMode;
  lastReceivedMessageId: number | null;
  lastAckedMessageId: number | null;
  pendingClientMessageId: string | null;
  queuedInbound: SessionMessageEvent[];
  terminal: TerminalState | null;
}

export type DraftModeChangeReason =
  | "interrupted"
  | "fallback_timeout"
  | "manual_complete";

export type DraftControllerEvent =
  | {
      kind: "draft_mode_changed";
      draftMode: DraftMode;
      reason: DraftModeChangeReason;
    }
  | {
      kind: "send_completed";
      ackMessageId: number;
      clientMessageId: string;
    }
  | {
      kind: "inbound_queued";
      messageId: number;
    }
  | {
      kind: "inbound_released";
      message: SessionMessageEvent;
    }
  | {
      kind: "inbound";
      message: SessionMessageEvent;
    }
  | TerminalState;

export function createInitialSessionHelperState(
  roomId: string,
): SessionHelperState {
  return {
    roomId,
    draftMode: "auto",
    lastReceivedMessageId: null,
    lastAckedMessageId: null,
    pendingClientMessageId: null,
    queuedInbound: [],
    terminal: null,
  };
}

export function cloneSessionHelperState(
  state: SessionHelperState,
): SessionHelperState {
  return {
    ...state,
    queuedInbound: state.queuedInbound.map((message) => ({ ...message })),
    terminal: state.terminal ? { ...state.terminal } : null,
  };
}
