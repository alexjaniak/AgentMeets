import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTestDatabase, TestAgent, JoinError } from "./helpers.js";
import { createRoom, getRoom } from "../../src/db/rooms.js";
import { getMessages } from "../../src/db/messages.js";
import { expireRoom } from "../../src/db/rooms.js";
import {
  createSessionAdapter,
  type SessionAdapterName,
} from "../../../session-helper/src/cli.js";
import { detectInvite } from "../../../session-helper/src/adapters/detect-invite.js";
import { DEFAULT_COUNTDOWN_MS } from "../../../session-helper/src/countdown.js";
import { createDraftController } from "../../../session-helper/src/draft-controller.js";
import { createInitialSessionHelperState } from "../../../session-helper/src/protocol.js";
import { renderLocalStatus, waitingForFromStatus } from "../../../session-helper/src/local-ui.js";

let db: Database;

beforeEach(() => {
  db = createTestDatabase();
});

afterEach(() => {
  db.close();
});

function createAdapterHarness(adapterName: SessionAdapterName) {
  const writes: string[] = [];
  const adapter = createSessionAdapter({
    adapterName,
    writeToPty(chunk) {
      writes.push(String(chunk));
    },
  });

  return { adapter, writes };
}

describe("happy path — full conversation", () => {
  test("create → join → exchange messages → end", async () => {
    const agentA = new TestAgent(db);
    const agentB = new TestAgent(db);

    // 1. Agent A creates a room
    const { roomId } = await agentA.createMeet();
    expect(roomId).toMatch(/^[A-Z0-9]{6}$/);

    // Verify room is in waiting state
    const roomAfterCreate = getRoom(db, roomId)!;
    expect(roomAfterCreate.status).toBe("waiting");

    // 2. Agent A sends a message (before guest joins)
    await agentA.sendAndWait("Hello, what's your API version?");

    // 3. Agent B joins and gets pending message
    const joinResult = await agentB.joinMeet(roomId);
    expect(joinResult.status).toBe("connected");
    expect(joinResult.pending).toEqual(["Hello, what's your API version?"]);

    // Verify room is now active
    const roomAfterJoin = getRoom(db, roomId)!;
    expect(roomAfterJoin.status).toBe("active");

    // 4. Agent B sends reply
    await agentB.sendAndWait("v2.1");

    // 5. Agent A gets the reply
    const replyA = agentA.getReply();
    expect(replyA.status).toBe("ok");
    expect(replyA.reply).toBe("v2.1");

    // 6. Agent A sends another message
    await agentA.sendAndWait("Thanks!");

    // 7. Agent B gets the message
    const replyB = agentB.getReply();
    expect(replyB.status).toBe("ok");
    expect(replyB.reply).toBe("Thanks!");

    // 8. Agent B ends the meet
    const endResult = await agentB.endMeet();
    expect(endResult.status).toBe("ended");

    // 9. Agent A sees the room is ended
    const statusA = agentA.getReply();
    expect(statusA.status).toBe("ended");
    expect(statusA.reason).toBe("user_ended");

    // Verify room is closed in DB
    const roomFinal = getRoom(db, roomId)!;
    expect(roomFinal.status).toBe("closed");
    expect(roomFinal.close_reason).toBe("user_ended");
  });
});

describe("mixed-client helper integration", () => {
  test("Claude Code host + Codex guest preserve native prompt formatting on both sides", async () => {
    const host = createAdapterHarness("claude-code");
    const guest = createAdapterHarness("codex");

    await guest.adapter.injectRemoteMessage({
      remoteRole: "host",
      content: "Opening context from the Claude host.",
    });
    await host.adapter.injectRemoteMessage({
      remoteRole: "guest",
      content: "Reply from the Codex guest.",
    });

    expect(guest.writes).toEqual([
      [
        "[agentmeets codex remote-message]",
        "remote_role=host",
        "draft_command=/draft <message>",
        "---",
        "Opening context from the Claude host.",
        "",
      ].join("\n"),
    ]);

    expect(host.writes).toEqual([
      [
        "[agentmeets remote-message]",
        "remote-role: guest",
        "message:",
        "Reply from the Codex guest.",
        "submit-final-draft: /draft <message>",
        "",
      ].join("\n"),
    ]);
  });

  test("Codex host + Claude Code guest preserve native prompt formatting on both sides", async () => {
    const host = createAdapterHarness("codex");
    const guest = createAdapterHarness("claude-code");

    await guest.adapter.injectRemoteMessage({
      remoteRole: "host",
      content: "Opening context from the Codex host.",
    });
    await host.adapter.injectRemoteMessage({
      remoteRole: "guest",
      content: "Reply from the Claude guest.",
    });

    expect(guest.writes).toEqual([
      [
        "[agentmeets remote-message]",
        "remote-role: host",
        "message:",
        "Opening context from the Codex host.",
        "submit-final-draft: /draft <message>",
        "",
      ].join("\n"),
    ]);

    expect(host.writes).toEqual([
      [
        "[agentmeets codex remote-message]",
        "remote_role=guest",
        "draft_command=/draft <message>",
        "---",
        "Reply from the Claude guest.",
        "",
      ].join("\n"),
    ]);
  });

  test("draft mode keeps the same regenerate/end semantics on both clients", async () => {
    for (const adapterName of ["claude-code", "codex"] as const) {
      const { adapter, writes } = createAdapterHarness(adapterName);

      await adapter.enterDraftMode({
        originalDraft: "Initial shared draft.",
        workingDraft: "Initial shared draft.",
      });

      expect(adapter.routeDraftCommand("/regenerate")).toEqual({
        kind: "regenerate_draft",
        originalDraft: "Initial shared draft.",
        workingDraft: "Initial shared draft.",
      });

      await adapter.enterDraftMode({
        originalDraft: "This replacement must be ignored.",
        workingDraft: "Tighter second pass.",
      });

      expect(adapter.routeDraftCommand("/regenerate")).toEqual({
        kind: "regenerate_draft",
        originalDraft: "Initial shared draft.",
        workingDraft: "Tighter second pass.",
      });
      expect(adapter.routeDraftCommand("/end")).toEqual({
        kind: "end_session",
      });

      expect(writes[0]).toContain("/regenerate");
      expect(writes[0]).toContain("/end");
      expect(writes[0]).toContain("Initial shared draft.");
      expect(writes[1]).toContain("Initial shared draft.");
      expect(writes[1]).toContain("Tighter second pass.");
    }
  });
});

describe("room expiry", () => {
  test("accepted messages update last_activity_at", async () => {
    const agentA = new TestAgent(db);
    const agentB = new TestAgent(db);
    const { roomId } = await agentA.createMeet();
    await agentB.joinMeet(roomId);

    const staleActivity = "2000-03-24 12:00:00";
    db.prepare("UPDATE rooms SET last_activity_at = ? WHERE id = ?").run(staleActivity, roomId);

    await agentA.sendAndWait("Still there?");

    const room = db
      .prepare("SELECT last_activity_at FROM rooms WHERE id = ?")
      .get(roomId) as { last_activity_at: string | null };
    expect(room.last_activity_at).toEqual(expect.any(String));
    expect(room.last_activity_at).not.toBe(staleActivity);
    expect(Date.parse(room.last_activity_at!)).toBeGreaterThan(Date.parse(staleActivity));
  });

  test("room expires when no one joins within timeout", async () => {
    const agentA = new TestAgent(db);
    const { roomId } = await agentA.createMeet();

    // Simulate expiry (in real server this would be a timer)
    expireRoom(db, roomId);

    const room = getRoom(db, roomId)!;
    expect(room.status).toBe("expired");
    expect(room.closed_at).toBeTruthy();

    // Trying to join an expired room should fail
    const agentB = new TestAgent(db);
    expect(() => agentB.joinMeet(roomId)).toThrow("Room is expired");
  });

  test("room status transitions to expired correctly", async () => {
    const agentA = new TestAgent(db);
    const { roomId } = await agentA.createMeet();

    // Room starts as waiting
    expect(getRoom(db, roomId)!.status).toBe("waiting");

    // After expiry
    expireRoom(db, roomId);
    expect(getRoom(db, roomId)!.status).toBe("expired");
  });
});

describe("double join rejection", () => {
  test("third agent gets 409 when room is already full", async () => {
    const agentA = new TestAgent(db);
    const agentB = new TestAgent(db);
    const agentC = new TestAgent(db);

    const { roomId } = await agentA.createMeet();
    await agentB.joinMeet(roomId);

    try {
      await agentC.joinMeet(roomId);
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(JoinError);
      expect((err as JoinError).statusCode).toBe(409);
      expect((err as JoinError).message).toBe("Room is full");
    }
  });
});

describe("end from host side", () => {
  test("host ends meet, guest sees ended status", async () => {
    const agentA = new TestAgent(db);
    const agentB = new TestAgent(db);

    const { roomId } = await agentA.createMeet();
    await agentB.joinMeet(roomId);

    // Exchange a message so both are connected
    await agentA.sendAndWait("Hello");
    await agentB.sendAndWait("Hi");

    // Host ends the meet
    await agentA.endMeet();

    // Guest checks status
    const guestStatus = agentB.getReply();
    expect(guestStatus.status).toBe("ended");
    expect(guestStatus.reason).toBe("user_ended");

    // Verify DB state
    const room = getRoom(db, roomId)!;
    expect(room.status).toBe("closed");
    expect(room.close_reason).toBe("user_ended");
  });
});

describe("end from guest side", () => {
  test("guest ends meet, host sees ended status", async () => {
    const agentA = new TestAgent(db);
    const agentB = new TestAgent(db);

    const { roomId } = await agentA.createMeet();
    await agentB.joinMeet(roomId);

    // Exchange a message
    await agentA.sendAndWait("Hello");
    await agentB.sendAndWait("Hi");

    // Guest ends the meet
    await agentB.endMeet();

    // Host checks status
    const hostStatus = agentA.getReply();
    expect(hostStatus.status).toBe("ended");
    expect(hostStatus.reason).toBe("user_ended");
  });
});

describe("invalid room code", () => {
  test("joining non-existent room returns 404", async () => {
    const agent = new TestAgent(db);

    try {
      await agent.joinMeet("XXXXXX");
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(JoinError);
      expect((err as JoinError).statusCode).toBe(404);
      expect((err as JoinError).message).toBe("Room not found");
    }
  });

  test("joining closed room returns 410", async () => {
    const agentA = new TestAgent(db);
    const agentB = new TestAgent(db);
    const agentC = new TestAgent(db);

    const { roomId } = await agentA.createMeet();
    await agentB.joinMeet(roomId);
    await agentA.endMeet();

    try {
      await agentC.joinMeet(roomId);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(JoinError);
      expect((err as JoinError).statusCode).toBe(410);
      expect((err as JoinError).message).toBe("Room is closed");
    }
  });
});

describe("message persistence verification", () => {
  test("opening message is persisted for later guest replay", () => {
    const room = createRoom(db, "OPEN01", "host-token-1", "Opening context");
    const messages = getMessages(db, room.id);

    expect(room.opening_message_id).toEqual(expect.any(Number));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: room.opening_message_id,
      room_id: room.id,
      sender: "host",
      content: "Opening context",
    });
  });

  test("messages are persisted in SQLite in order", async () => {
    const agentA = new TestAgent(db);
    const agentB = new TestAgent(db);

    const { roomId } = await agentA.createMeet();

    // Host sends a message before guest joins
    await agentA.sendAndWait("First message from host");

    await agentB.joinMeet(roomId);

    // Exchange more messages
    await agentB.sendAndWait("Reply from guest");
    await agentA.sendAndWait("Second from host");
    await agentB.sendAndWait("Final from guest");

    // Query DB directly to verify persistence
    const messages = getMessages(db, roomId);
    expect(messages).toHaveLength(4);

    expect(messages[0].sender).toBe("host");
    expect(messages[0].content).toBe("First message from host");
    expect(messages[0].room_id).toBe(roomId);

    expect(messages[1].sender).toBe("guest");
    expect(messages[1].content).toBe("Reply from guest");

    expect(messages[2].sender).toBe("host");
    expect(messages[2].content).toBe("Second from host");

    expect(messages[3].sender).toBe("guest");
    expect(messages[3].content).toBe("Final from guest");

    // Verify ordering is correct (IDs are monotonically increasing)
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].id).toBeGreaterThan(messages[i - 1].id);
    }
  });

  test("messages include timestamps", async () => {
    const agentA = new TestAgent(db);
    const agentB = new TestAgent(db);

    const { roomId } = await agentA.createMeet();
    await agentA.sendAndWait("Hello");
    await agentB.joinMeet(roomId);
    await agentB.sendAndWait("World");

    const messages = getMessages(db, roomId);
    for (const msg of messages) {
      expect(msg.created_at).toBeTruthy();
      expect(typeof msg.created_at).toBe("string");
    }
  });

  test("no leftover data between tests", () => {
    // Each test gets a fresh :memory: database, so there should be no rooms
    const stmt = db.prepare("SELECT COUNT(*) as count FROM rooms");
    const result = stmt.get() as { count: number };
    expect(result.count).toBe(0);
  });
});

describe("edge cases", () => {
  test("agent cannot send before connecting to a room", async () => {
    const agent = new TestAgent(db);
    expect(() => agent.sendAndWait("Hello")).toThrow("Not connected to a room");
  });

  test("agent cannot end meet before connecting", async () => {
    const agent = new TestAgent(db);
    expect(() => agent.endMeet()).toThrow("Not connected to a room");
  });

  test("multiple rooms can coexist", async () => {
    const agentA1 = new TestAgent(db);
    const agentB1 = new TestAgent(db);
    const agentA2 = new TestAgent(db);
    const agentB2 = new TestAgent(db);

    const { roomId: room1 } = await agentA1.createMeet();
    const { roomId: room2 } = await agentA2.createMeet();

    expect(room1).not.toBe(room2);

    await agentB1.joinMeet(room1);
    await agentB2.joinMeet(room2);

    // Messages in room1 don't affect room2
    await agentA1.sendAndWait("Room 1 message");
    await agentA2.sendAndWait("Room 2 message");

    const messages1 = getMessages(db, room1);
    const messages2 = getMessages(db, room2);

    expect(messages1).toHaveLength(1);
    expect(messages1[0].content).toBe("Room 1 message");

    expect(messages2).toHaveLength(1);
    expect(messages2[0].content).toBe("Room 2 message");
  });

  test("room lifecycle is fully tracked in DB", async () => {
    const agentA = new TestAgent(db);
    const agentB = new TestAgent(db);

    const { roomId } = await agentA.createMeet();

    // Check waiting state
    let room = getRoom(db, roomId)!;
    expect(room.status).toBe("waiting");
    expect(room.host_token).toBeTruthy();
    expect(room.guest_token).toBeNull();
    expect(room.joined_at).toBeNull();
    expect(room.closed_at).toBeNull();

    // Join transitions to active
    await agentB.joinMeet(roomId);
    room = getRoom(db, roomId)!;
    expect(room.status).toBe("active");
    expect(room.guest_token).toBeTruthy();
    expect(room.joined_at).toBeTruthy();

    // Close transitions to closed
    await agentA.endMeet();
    room = getRoom(db, roomId)!;
    expect(room.status).toBe("closed");
    expect(room.closed_at).toBeTruthy();
    expect(room.close_reason).toBe("user_ended");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ZERO-SETUP INTEGRATION TESTS
// Verify that the three implementation lanes (MCP, session-helper, browser)
// wire together correctly in the final product flow.
// ────────────────────────────────────────────────────────────────────────────

describe("zero-setup integration — MCP output feeds bootstrap input", () => {
  test("create_meet agent links are parseable by detectInvite", () => {
    // Simulates the shape returned by create_meet → CreateRoomResponse
    const roomStem = "r_9wK3mQvH8";
    const serverOrigin = "https://agentmeets.example.com";
    const hostAgentLink = `${serverOrigin}/j/host_token_abc123`;
    const guestAgentLink = `${serverOrigin}/j/guest_token_xyz789`;

    // The MCP tool returns these as yourAgentLink / otherAgentLink
    const mcpOutput = {
      roomLabel: `Room ${roomStem}`,
      status: "waiting_for_both",
      yourAgentLink: hostAgentLink,
      otherAgentLink: guestAgentLink,
      yourAgentInstruction: `Tell your agent to join this chat: ${hostAgentLink}`,
      otherAgentInstruction: `Tell the other agent to join this chat: ${guestAgentLink}`,
    };

    // detectInvite must parse both links from their instruction strings
    const hostInvite = detectInvite(mcpOutput.yourAgentInstruction);
    const guestInvite = detectInvite(mcpOutput.otherAgentInstruction);

    expect(hostInvite).not.toBeNull();
    expect(guestInvite).not.toBeNull();
    expect(hostInvite!.inviteToken).toBe("host_token_abc123");
    expect(guestInvite!.inviteToken).toBe("guest_token_xyz789");
    expect(hostInvite!.inviteUrl).toBe(hostAgentLink);
    expect(guestInvite!.inviteUrl).toBe(guestAgentLink);
  });

  test("detectInvite extracts token from bare URL (paste-invite flow)", () => {
    const pastedText =
      "Join this meet: https://meets.example.io/j/inv_ABC.def-123 and let me know";
    const invite = detectInvite(pastedText);

    expect(invite).not.toBeNull();
    expect(invite!.inviteToken).toBe("inv_ABC.def-123");
    expect(invite!.inviteUrl).toBe("https://meets.example.io/j/inv_ABC.def-123");
  });

  test("detectInvite rejects URLs without /j/ path", () => {
    expect(detectInvite("https://example.com/rooms/ABC")).toBeNull();
    expect(detectInvite("https://example.com/invite/ABC")).toBeNull();
    expect(detectInvite("no url here")).toBeNull();
  });
});

describe("zero-setup integration — room identity", () => {
  test("roomLabel format is 'Room <stem>' across all surfaces", () => {
    const roomStem = "r_9wK3mQvH8";
    const expectedLabel = `Room ${roomStem}`;

    // 1. MCP create_meet uses this format
    expect(`Room ${roomStem}`).toBe(expectedLabel);

    // 2. renderLocalStatus connected surface includes the label
    const connectedSurface = renderLocalStatus({
      kind: "connected",
      role: "host",
      roomLabel: expectedLabel,
    });
    expect(connectedSurface).toContain(`room: ${expectedLabel}`);
    expect(connectedSurface).toContain("role: host");

    // 3. renderLocalStatus waiting surface includes the label
    const waitingSurface = renderLocalStatus({
      kind: "waiting_for_other_side",
      role: "guest",
      roomLabel: expectedLabel,
      waitingFor: "host",
    });
    expect(waitingSurface).toContain(`room: ${expectedLabel}`);
    expect(waitingSurface).toContain("status: waiting for host");

    // 4. staged pre-activation surface includes the label
    const stagedSurface = renderLocalStatus({
      kind: "staged_pre_activation",
      role: "guest",
      roomLabel: expectedLabel,
    });
    expect(stagedSurface).toContain(`room: ${expectedLabel}`);
    expect(stagedSurface).toContain("status: staged pre-activation");
  });

  test("waitingForFromStatus maps bootstrap statuses correctly", () => {
    expect(waitingForFromStatus("waiting_for_host")).toBe("host");
    expect(waitingForFromStatus("waiting_for_guest")).toBe("guest");
    expect(waitingForFromStatus("waiting_for_both")).toBe("other side");
    expect(waitingForFromStatus("active")).toBeNull();
    expect(waitingForFromStatus("ended")).toBeNull();
    expect(waitingForFromStatus("expired")).toBeNull();
  });
});

describe("zero-setup integration — countdown default", () => {
  test("DEFAULT_COUNTDOWN_MS is 5 seconds", () => {
    expect(DEFAULT_COUNTDOWN_MS).toBe(5_000);
  });

  test("hold countdown surface shows seconds derived from DEFAULT_COUNTDOWN_MS", () => {
    const holdSeconds = Math.round(DEFAULT_COUNTDOWN_MS / 1_000);
    const surface = renderLocalStatus({
      kind: "hold_countdown",
      secondsRemaining: holdSeconds,
    });
    expect(surface).toBe(
      "[agentmeets hold] Sending in 5s. Press e to edit.\n",
    );
  });
});

describe("zero-setup integration — draft state immutability", () => {
  test("originalDraft is frozen after first acceptDraft; workingDraft changes", () => {
    const controller = createDraftController({
      roomId: "test-room",
      initialState: {
        ...createInitialSessionHelperState("test-room"),
        isRoomActive: true,
      },
    });

    // Simulate inbound message
    const inboundEvents = controller.processServerMessage({
      type: "message",
      messageId: 1,
      sender: "host",
      clientMessageId: "cm-1",
      replyToMessageId: null,
      content: "What is your API version?",
      createdAt: new Date().toISOString(),
    });
    expect(inboundEvents[0]).toMatchObject({ kind: "inbound" });

    // First draft — sets originalDraft
    const firstDraft = controller.acceptDraft("First pass");
    expect(firstDraft.kind).toBe("draft_prepared");
    expect(firstDraft).toMatchObject({
      originalDraft: "First pass",
      workingDraft: "First pass",
    });

    // Verify state
    let state = controller.getSnapshot();
    expect(state.originalDraft).toBe("First pass");
    expect(state.workingDraft).toBe("First pass");

    // Second draft — originalDraft stays frozen, workingDraft updates
    const secondDraft = controller.acceptDraft("Revised pass");
    expect(secondDraft.kind).toBe("draft_updated");
    expect(secondDraft).toMatchObject({
      originalDraft: "First pass",
      workingDraft: "Revised pass",
    });

    state = controller.getSnapshot();
    expect(state.originalDraft).toBe("First pass");
    expect(state.workingDraft).toBe("Revised pass");

    // Third draft — originalDraft still frozen
    controller.acceptDraft("Final pass");
    state = controller.getSnapshot();
    expect(state.originalDraft).toBe("First pass");
    expect(state.workingDraft).toBe("Final pass");
  });

  test("revertDraft restores workingDraft to originalDraft", () => {
    const controller = createDraftController({
      roomId: "test-room",
      initialState: {
        ...createInitialSessionHelperState("test-room"),
        isRoomActive: true,
      },
    });

    controller.processServerMessage({
      type: "message",
      messageId: 1,
      sender: "host",
      clientMessageId: "cm-1",
      replyToMessageId: null,
      content: "Hello",
      createdAt: new Date().toISOString(),
    });

    controller.acceptDraft("First pass");
    controller.acceptDraft("Modified version");

    const revertEvent = controller.revertDraft();
    expect(revertEvent).toMatchObject({
      kind: "draft_updated",
      originalDraft: "First pass",
      workingDraft: "First pass",
    });

    const state = controller.getSnapshot();
    expect(state.originalDraft).toBe("First pass");
    expect(state.workingDraft).toBe("First pass");
    expect(state.status).toBe("draft_mode");
    expect(state.draftMode).toBe("manual");
  });
});

describe("zero-setup integration — draft lifecycle end-to-end", () => {
  test("inbound → acceptDraft → countdown expired → send_requested", () => {
    const controller = createDraftController({
      roomId: "test-room",
      initialState: {
        ...createInitialSessionHelperState("test-room"),
        isRoomActive: true,
      },
    });

    // 1. Process inbound message
    const inboundEvents = controller.processServerMessage({
      type: "message",
      messageId: 42,
      sender: "host",
      clientMessageId: "cm-42",
      replyToMessageId: null,
      content: "Opening message from host",
      createdAt: new Date().toISOString(),
    });
    expect(inboundEvents).toHaveLength(1);
    expect(inboundEvents[0]).toMatchObject({
      kind: "inbound",
      message: { content: "Opening message from host", sender: "host" },
    });

    // State should be drafting_reply
    expect(controller.getSnapshot().status).toBe("drafting_reply");

    // 2. Accept draft (first pass triggers auto-hold)
    const draftEvent = controller.acceptDraft(
      "Guest reply after 5s hold",
      new Date(Date.now() + DEFAULT_COUNTDOWN_MS).toISOString(),
    );
    expect(draftEvent.kind).toBe("draft_prepared");
    expect(controller.getSnapshot().status).toBe("hold_countdown");

    // 3. Countdown expires → sends
    const countdownResult = controller.applyCountdownResult({
      kind: "expired",
      durationMs: DEFAULT_COUNTDOWN_MS,
    });
    expect(countdownResult.kind).toBe("send_requested");
    if (countdownResult.kind === "send_requested") {
      expect(countdownResult.payload.content).toBe(
        "Guest reply after 5s hold",
      );
    }

    // State transitions to sending
    expect(controller.getSnapshot().status).toBe("sending");
  });

  test("inbound → acceptDraft → countdown interrupted → draft_mode (manual)", () => {
    const controller = createDraftController({
      roomId: "test-room",
      initialState: {
        ...createInitialSessionHelperState("test-room"),
        isRoomActive: true,
      },
    });

    controller.processServerMessage({
      type: "message",
      messageId: 1,
      sender: "host",
      clientMessageId: "cm-1",
      replyToMessageId: null,
      content: "Hello",
      createdAt: new Date().toISOString(),
    });

    controller.acceptDraft(
      "Auto draft",
      new Date(Date.now() + DEFAULT_COUNTDOWN_MS).toISOString(),
    );
    expect(controller.getSnapshot().status).toBe("hold_countdown");

    // User presses 'e' to interrupt
    const interruptEvent = controller.applyCountdownResult({
      kind: "interrupted",
      key: "e",
    });
    expect(interruptEvent).toMatchObject({
      kind: "draft_mode_changed",
      draftMode: "manual",
      reason: "interrupted",
    });

    const state = controller.getSnapshot();
    expect(state.status).toBe("draft_mode");
    expect(state.draftMode).toBe("manual");
    expect(state.workingDraft).toBe("Auto draft");
  });

  test("pre-activation: guest drafts before room is active, sends on room_active", () => {
    const controller = createDraftController({
      roomId: "test-room",
      initialState: {
        ...createInitialSessionHelperState("test-room"),
        isRoomActive: false, // room not yet active
      },
    });

    // Guest receives opening message (via replay or server)
    controller.processServerMessage({
      type: "message",
      messageId: 1,
      sender: "host",
      clientMessageId: "cm-1",
      replyToMessageId: null,
      content: "Opening",
      createdAt: new Date().toISOString(),
    });

    // Guest drafts a response
    controller.acceptDraft(
      "Staged response",
      new Date(Date.now() + DEFAULT_COUNTDOWN_MS).toISOString(),
    );

    // Countdown expires while room is NOT active → stages pre-activation
    const stagedEvent = controller.applyCountdownResult({
      kind: "expired",
      durationMs: DEFAULT_COUNTDOWN_MS,
    });
    expect(stagedEvent.kind).toBe("staged_pre_activation");

    const stateBeforeActive = controller.getSnapshot();
    expect(stateBeforeActive.stagedBeforeActivation).toBe(true);

    // Room becomes active → auto-sends the staged draft
    const activateEvents = controller.processServerMessage({
      type: "room_active",
    });
    expect(activateEvents).toHaveLength(1);
    expect(activateEvents[0]).toMatchObject({
      kind: "send_requested",
      payload: { content: "Staged response" },
    });
  });

  test("ack resets draft state and releases queued inbound", () => {
    const controller = createDraftController({
      roomId: "test-room",
      initialState: {
        ...createInitialSessionHelperState("test-room"),
        isRoomActive: true,
      },
    });

    // Receive and reply to first message
    controller.processServerMessage({
      type: "message",
      messageId: 1,
      sender: "host",
      clientMessageId: "cm-1",
      replyToMessageId: null,
      content: "First message",
      createdAt: new Date().toISOString(),
    });

    // Send via sendCurrentDraft after accepting
    controller.acceptDraft("Reply to first");
    const sendEvent = controller.sendCurrentDraft();
    expect(sendEvent.kind).toBe("send_requested");

    // While send is pending, another message arrives → gets queued
    const queuedEvents = controller.processServerMessage({
      type: "message",
      messageId: 2,
      sender: "host",
      clientMessageId: "cm-2",
      replyToMessageId: null,
      content: "Second message",
      createdAt: new Date().toISOString(),
    });
    expect(queuedEvents[0]).toMatchObject({
      kind: "inbound_queued",
      messageId: 2,
    });

    // Ack arrives → resets state and releases queued message
    const clientMessageId =
      sendEvent.kind === "send_requested"
        ? sendEvent.payload.clientMessageId
        : "";
    const ackEvents = controller.processServerMessage({
      type: "ack",
      messageId: 100,
      clientMessageId,
      replyToMessageId: 1,
      createdAt: new Date().toISOString(),
    });
    expect(ackEvents).toHaveLength(2);
    expect(ackEvents[0]).toMatchObject({ kind: "send_completed" });
    expect(ackEvents[1]).toMatchObject({
      kind: "inbound_released",
      message: { content: "Second message" },
    });

    // State is back to drafting_reply for the released message
    const state = controller.getSnapshot();
    expect(state.status).toBe("drafting_reply");
    expect(state.originalDraft).toBeNull();
    expect(state.workingDraft).toBe("");
    expect(state.activeMessageId).toBe(2);
  });
});

describe("zero-setup integration — all four client pairings", () => {
  const adapterPairings: [SessionAdapterName, SessionAdapterName][] = [
    ["claude-code", "claude-code"],
    ["claude-code", "codex"],
    ["codex", "claude-code"],
    ["codex", "codex"],
  ];

  for (const [hostAdapter, guestAdapter] of adapterPairings) {
    test(`${hostAdapter} host + ${guestAdapter} guest: draft commands are equivalent`, async () => {
      const host = createAdapterHarness(hostAdapter);
      const guest = createAdapterHarness(guestAdapter);

      // Both adapters enter draft mode with same content
      await host.adapter.enterDraftMode({
        originalDraft: "Shared draft content",
        workingDraft: "Shared draft content",
      });
      await guest.adapter.enterDraftMode({
        originalDraft: "Shared draft content",
        workingDraft: "Shared draft content",
      });

      // All draft commands must produce equivalent routing
      expect(host.adapter.routeDraftCommand("/send")).toEqual({
        kind: "send_draft",
      });
      expect(guest.adapter.routeDraftCommand("/send")).toEqual({
        kind: "send_draft",
      });

      expect(host.adapter.routeDraftCommand("/regenerate")).toEqual({
        kind: "regenerate_draft",
        originalDraft: "Shared draft content",
        workingDraft: "Shared draft content",
      });
      expect(guest.adapter.routeDraftCommand("/regenerate")).toEqual({
        kind: "regenerate_draft",
        originalDraft: "Shared draft content",
        workingDraft: "Shared draft content",
      });

      expect(host.adapter.routeDraftCommand("/revert")).toEqual({
        kind: "revert_draft",
      });
      expect(guest.adapter.routeDraftCommand("/revert")).toEqual({
        kind: "revert_draft",
      });

      expect(host.adapter.routeDraftCommand("/end")).toEqual({
        kind: "end_session",
      });
      expect(guest.adapter.routeDraftCommand("/end")).toEqual({
        kind: "end_session",
      });

      expect(host.adapter.routeDraftCommand("/draft My message")).toEqual({
        kind: "submit_draft",
        content: "My message",
      });
      expect(guest.adapter.routeDraftCommand("/draft My message")).toEqual({
        kind: "submit_draft",
        content: "My message",
      });

      // Free-form feedback in draft mode
      expect(host.adapter.routeDraftCommand("make it shorter")).toEqual({
        kind: "draft_feedback",
        feedback: "make it shorter",
      });
      expect(guest.adapter.routeDraftCommand("make it shorter")).toEqual({
        kind: "draft_feedback",
        feedback: "make it shorter",
      });
    });

    test(`${hostAdapter} host + ${guestAdapter} guest: originalDraft preserved across renderDraftMode calls`, async () => {
      const host = createAdapterHarness(hostAdapter);
      const guest = createAdapterHarness(guestAdapter);

      // First enter with original draft
      await host.adapter.enterDraftMode({
        originalDraft: "First pass",
        workingDraft: "First pass",
      });
      await guest.adapter.enterDraftMode({
        originalDraft: "First pass",
        workingDraft: "First pass",
      });

      // Second enter with different originalDraft — adapter preserves the first
      await host.adapter.renderDraftMode({
        originalDraft: "SHOULD BE IGNORED",
        workingDraft: "Edited version",
        controls: ["/send", "/regenerate", "/revert", "/end"],
      });
      await guest.adapter.renderDraftMode({
        originalDraft: "SHOULD BE IGNORED",
        workingDraft: "Edited version",
        controls: ["/send", "/regenerate", "/revert", "/end"],
      });

      // /regenerate should report the original first-pass draft, not the ignored one
      expect(host.adapter.routeDraftCommand("/regenerate")).toEqual({
        kind: "regenerate_draft",
        originalDraft: "First pass",
        workingDraft: "Edited version",
      });
      expect(guest.adapter.routeDraftCommand("/regenerate")).toEqual({
        kind: "regenerate_draft",
        originalDraft: "First pass",
        workingDraft: "Edited version",
      });
    });
  }
});

describe("zero-setup integration — error surfaces", () => {
  test("failure surfaces render deterministic error codes", () => {
    const invalidInvite = renderLocalStatus({
      kind: "failure",
      code: "invalid_invite",
    });
    expect(invalidInvite).toContain("[agentmeets error]");
    expect(invalidInvite).toContain("code: invalid_invite");

    const expiredInvite = renderLocalStatus({
      kind: "failure",
      code: "invite_expired",
    });
    expect(expiredInvite).toContain("code: invite_expired");

    const runtimeFailure = renderLocalStatus({
      kind: "failure",
      code: "runtime_failure",
      detail: "WebSocket connection failed",
    });
    expect(runtimeFailure).toContain("code: runtime_failure");
    expect(runtimeFailure).toContain("detail: WebSocket connection failed");
  });

  test("terminal events halt the draft controller", () => {
    const controller = createDraftController({
      roomId: "test-room",
      initialState: {
        ...createInitialSessionHelperState("test-room"),
        isRoomActive: true,
      },
    });

    // End the session
    const endEvents = controller.processServerMessage({
      type: "ended",
      reason: "user_ended",
    });
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0]).toMatchObject({
      kind: "ended",
      reason: "user_ended",
    });

    const state = controller.getSnapshot();
    expect(state.status).toBe("ended");
    expect(state.terminal).toMatchObject({
      kind: "ended",
      reason: "user_ended",
    });

    // Further server messages are ignored
    const noEvents = controller.processServerMessage({
      type: "message",
      messageId: 99,
      sender: "host",
      clientMessageId: "cm-99",
      replyToMessageId: null,
      content: "Should be ignored",
      createdAt: new Date().toISOString(),
    });
    expect(noEvents).toHaveLength(0);
  });
});
