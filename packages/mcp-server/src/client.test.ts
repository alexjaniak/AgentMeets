import { describe, expect, test } from "bun:test";
import {
  createMeetState,
  createMessagePayload,
  processServerMessage,
} from "./client.js";

describe("MCP WS client protocol helpers", () => {
  test("threads outbound messages to the last received server message id", () => {
    const state = createMeetState("ROOM01", "token-123", "host", null);

    const firstPayload = createMessagePayload(state, "hello");
    expect(firstPayload.type).toBe("message");
    expect(typeof firstPayload.clientMessageId).toBe("string");
    expect(firstPayload.replyToMessageId).toBeNull();
    expect(firstPayload.content).toBe("hello");

    expect(
      processServerMessage(state, {
        type: "room_active",
      }),
    ).toEqual({ kind: "none" });
    expect(state.isRoomActive).toBe(true);

    expect(
      processServerMessage(state, {
        type: "ack",
        messageId: 1,
        clientMessageId: firstPayload.clientMessageId,
        replyToMessageId: null,
        createdAt: "2026-03-24 12:00:00",
      }),
    ).toEqual({ kind: "none" });
    expect(state.lastAckedMessageId).toBe(1);

    expect(
      processServerMessage(state, {
        type: "message",
        messageId: 2,
        sender: "guest",
        clientMessageId: "guest-msg-1",
        replyToMessageId: 1,
        content: "reply",
        createdAt: "2026-03-24 12:00:01",
      }),
    ).toEqual({ kind: "message", content: "reply" });

    const secondPayload = createMessagePayload(state, "follow up");
    expect(typeof secondPayload.clientMessageId).toBe("string");
    expect(secondPayload.clientMessageId).not.toBe(firstPayload.clientMessageId);
    expect(secondPayload.replyToMessageId).toBe(2);
    expect(secondPayload.content).toBe("follow up");
  });

  test("surfaces protocol errors and ended reasons", () => {
    const state = createMeetState("ROOM01", "token-123", "guest", null);

    expect(
      processServerMessage(state, {
        type: "error",
        code: "invalid_message",
        message: "bad payload",
      }),
    ).toEqual({
      kind: "error",
      code: "invalid_message",
      message: "bad payload",
    });

    expect(
      processServerMessage(state, {
        type: "ended",
        reason: "disconnected",
      }),
    ).toEqual({
      kind: "ended",
      reason: "disconnected",
    });
  });
});
