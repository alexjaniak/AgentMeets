import { describe, expect, test } from "bun:test";

describe("createDraftController", () => {
  test("moves from auto to manual draft mode on interruption or fallback", async () => {
    const module = await import("./draft-controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const controller = module.createDraftController({ roomId: "ROOM-123" });
    expect(controller.getSnapshot().draftMode).toBe("auto");

    expect(
      controller.applyCountdownResult({
        kind: "interrupted",
        key: "e",
      }),
    ).toEqual({
      kind: "draft_mode_changed",
      draftMode: "manual",
      reason: "interrupted",
    });
    expect(controller.getSnapshot().draftMode).toBe("manual");

    expect(controller.resumeAutoMode()).toEqual([
      {
        kind: "draft_mode_changed",
        draftMode: "auto",
        reason: "manual_complete",
      },
    ]);
    expect(controller.getSnapshot().draftMode).toBe("auto");

    expect(
      controller.applyCountdownResult({
        kind: "expired",
        durationMs: 120_000,
      }),
    ).toEqual({
      kind: "draft_mode_changed",
      draftMode: "manual",
      reason: "fallback_timeout",
    });
    expect(controller.getSnapshot().draftMode).toBe("manual");
  });

  test("queues inbound while manual draft mode is active and releases it when auto mode resumes", async () => {
    const module = await import("./draft-controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const controller = module.createDraftController({ roomId: "ROOM-123" });
    controller.applyCountdownResult({
      kind: "expired",
      durationMs: 120_000,
    });

    const inboundMessage = {
      type: "message" as const,
      messageId: 4,
      sender: "guest" as const,
      clientMessageId: "guest-4",
      replyToMessageId: null,
      content: "inbound while manual drafting",
      createdAt: "2026-03-24 12:00:04",
    };

    expect(controller.processServerMessage(inboundMessage)).toEqual([
      {
        kind: "inbound_queued",
        messageId: 4,
      },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      draftMode: "manual",
      lastReceivedMessageId: 4,
      queuedInbound: [inboundMessage],
    });

    expect(controller.resumeAutoMode()).toEqual([
      {
        kind: "draft_mode_changed",
        draftMode: "auto",
        reason: "manual_complete",
      },
      {
        kind: "inbound_released",
        message: inboundMessage,
      },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      draftMode: "auto",
      queuedInbound: [],
    });
  });

  test("queues inbound messages while waiting for ack and releases them after ack-gated completion", async () => {
    const module = await import("./draft-controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const controller = module.createDraftController({ roomId: "ROOM-123" });
    const outbound = controller.beginSend("draft reply");

    expect(outbound).toMatchObject({
      type: "message",
      replyToMessageId: null,
      content: "draft reply",
    });
    expect(typeof outbound.clientMessageId).toBe("string");
    expect(controller.getSnapshot().pendingClientMessageId).toBe(
      outbound.clientMessageId,
    );

    expect(
      controller.processServerMessage({
        type: "message",
        messageId: 4,
        sender: "guest",
        clientMessageId: "guest-4",
        replyToMessageId: null,
        content: "inbound while ack pending",
        createdAt: "2026-03-24 12:00:04",
      }),
    ).toEqual([
      {
        kind: "inbound_queued",
        messageId: 4,
      },
    ]);
    expect(controller.getSnapshot().queuedInbound).toHaveLength(1);

    expect(
      controller.processServerMessage({
        type: "ack",
        messageId: 5,
        clientMessageId: outbound.clientMessageId,
        replyToMessageId: null,
        createdAt: "2026-03-24 12:00:05",
      }),
    ).toEqual([
      {
        kind: "send_completed",
        ackMessageId: 5,
        clientMessageId: outbound.clientMessageId,
      },
      {
        kind: "inbound_released",
        message: {
          type: "message",
          messageId: 4,
          sender: "guest",
          clientMessageId: "guest-4",
          replyToMessageId: null,
          content: "inbound while ack pending",
          createdAt: "2026-03-24 12:00:04",
        },
      },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      pendingClientMessageId: null,
      lastAckedMessageId: 5,
      lastReceivedMessageId: 4,
      queuedInbound: [],
    });
  });

  test("treats ended and error events as terminal while a send is in flight", async () => {
    const module = await import("./draft-controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const controller = module.createDraftController({ roomId: "ROOM-123" });
    const outbound = controller.beginSend("draft reply");

    expect(
      controller.processServerMessage({
        type: "error",
        code: "invalid_message",
        message: "bad payload",
      }),
    ).toEqual([
      {
        kind: "error",
        code: "invalid_message",
        message: "bad payload",
      },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      pendingClientMessageId: null,
      terminal: {
        kind: "error",
        code: "invalid_message",
        message: "bad payload",
      },
    });

    const nextController = module.createDraftController({ roomId: "ROOM-456" });
    nextController.beginSend("another draft");

    expect(
      nextController.processServerMessage({
        type: "ended",
        reason: "timeout",
      }),
    ).toEqual([
      {
        kind: "ended",
        reason: "timeout",
      },
    ]);
    expect(nextController.getSnapshot()).toMatchObject({
      pendingClientMessageId: null,
      terminal: {
        kind: "ended",
        reason: "timeout",
      },
    });

    expect(
      nextController.processServerMessage({
        type: "ack",
        messageId: 9,
        clientMessageId: outbound.clientMessageId,
        replyToMessageId: null,
        createdAt: "2026-03-24 12:00:09",
      }),
    ).toEqual([]);
  });

  test("does not resume auto mode or release queued inbound after a terminal event", async () => {
    const module = await import("./draft-controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const controller = module.createDraftController({ roomId: "ROOM-789" });
    controller.applyCountdownResult({
      kind: "expired",
      durationMs: 120_000,
    });

    const queuedMessage = {
      type: "message" as const,
      messageId: 10,
      sender: "guest" as const,
      clientMessageId: "guest-10",
      replyToMessageId: null,
      content: "queued before shutdown",
      createdAt: "2026-03-24 12:00:10",
    };

    expect(controller.processServerMessage(queuedMessage)).toEqual([
      {
        kind: "inbound_queued",
        messageId: 10,
      },
    ]);

    expect(
      controller.processServerMessage({
        type: "ended",
        reason: "timeout",
      }),
    ).toEqual([
      {
        kind: "ended",
        reason: "timeout",
      },
    ]);

    expect(controller.resumeAutoMode()).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({
      draftMode: "manual",
      queuedInbound: [queuedMessage],
      terminal: {
        kind: "ended",
        reason: "timeout",
      },
    });
  });
});
