import { randomUUID } from "node:crypto";
import {
  cloneSessionHelperState,
  createInitialSessionHelperState,
  type CountdownResult,
  type DraftControllerEvent,
  type DraftMode,
  type SessionHelperState,
  type SessionMessagePayload,
  type SessionServerMessage,
  type TerminalState,
} from "./protocol.js";

export interface CreateDraftControllerOptions {
  roomId: string;
  initialState?: SessionHelperState;
}

export interface DraftController {
  getSnapshot(): SessionHelperState;
  resumeAutoMode(): DraftControllerEvent[];
  applyCountdownResult(result: CountdownResult): DraftControllerEvent;
  beginSend(content: string): SessionMessagePayload;
  processServerMessage(message: SessionServerMessage): DraftControllerEvent[];
}

export function createDraftController({
  roomId,
  initialState,
}: CreateDraftControllerOptions): DraftController {
  const state = initialState
    ? cloneSessionHelperState(initialState)
    : createInitialSessionHelperState(roomId);

  return {
    getSnapshot() {
      return cloneSessionHelperState(state);
    },
    resumeAutoMode() {
      if (state.terminal) {
        return [];
      }

      const events: DraftControllerEvent[] = [];

      if (state.draftMode !== "auto") {
        state.draftMode = "auto";
        events.push({
          kind: "draft_mode_changed",
          draftMode: "auto",
          reason: "manual_complete",
        });
      }

      if (!state.pendingClientMessageId) {
        events.push(...releaseQueuedInbound(state));
      }

      return events;
    },
    applyCountdownResult(result) {
      state.draftMode = "manual";
      return {
        kind: "draft_mode_changed",
        draftMode: "manual",
        reason:
          result.kind === "interrupted" ? "interrupted" : "fallback_timeout",
      };
    },
    beginSend(content) {
      if (state.terminal) {
        throw new Error("Cannot send after terminal event.");
      }

      if (state.pendingClientMessageId) {
        throw new Error("A send is already awaiting ack.");
      }

      const payload: SessionMessagePayload = {
        type: "message",
        clientMessageId: randomUUID(),
        replyToMessageId: state.lastReceivedMessageId,
        content,
      };

      state.pendingClientMessageId = payload.clientMessageId;
      return payload;
    },
    processServerMessage(message) {
      if (state.terminal) {
        return [];
      }

      switch (message.type) {
        case "room_active":
          return [];
        case "message":
          state.lastReceivedMessageId = message.messageId;
          if (shouldQueueInbound(state)) {
            state.queuedInbound.push({ ...message });
            return [
              {
                kind: "inbound_queued",
                messageId: message.messageId,
              },
            ];
          }

          return [
            {
              kind: "inbound",
              message: { ...message },
            },
          ];
        case "ack":
          if (state.pendingClientMessageId !== message.clientMessageId) {
            return [];
          }

          state.lastAckedMessageId = message.messageId;
          state.pendingClientMessageId = null;

          return [
            {
              kind: "send_completed",
              ackMessageId: message.messageId,
              clientMessageId: message.clientMessageId,
            },
            ...(state.draftMode === "auto" ? releaseQueuedInbound(state) : []),
          ];
        case "error":
          return finalize(state, {
            kind: "error",
            code: message.code,
            message: message.message,
          });
        case "ended":
          return finalize(state, {
            kind: "ended",
            reason: message.reason,
          });
      }
    },
  };
}

function shouldQueueInbound(state: SessionHelperState): boolean {
  return state.pendingClientMessageId !== null || state.draftMode === "manual";
}

function releaseQueuedInbound(
  state: SessionHelperState,
): DraftControllerEvent[] {
  const queued = state.queuedInbound.map((message) => ({
    kind: "inbound_released" as const,
    message: { ...message },
  }));

  state.queuedInbound = [];
  return queued;
}

function finalize(
  state: SessionHelperState,
  terminal: TerminalState,
): DraftControllerEvent[] {
  state.pendingClientMessageId = null;
  state.terminal = terminal;
  return [terminal];
}
