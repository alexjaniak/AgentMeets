import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTestDatabase, TestAgent, JoinError } from "./helpers.js";
import { getRoom } from "../../src/db/rooms.js";
import { getMessages } from "../../src/db/messages.js";
import { expireRoom } from "../../src/db/rooms.js";

let db: Database;

beforeEach(() => {
  db = createTestDatabase();
});

afterEach(() => {
  db.close();
});

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
    expect(statusA.reason).toBe("closed");

    // Verify room is closed in DB
    const roomFinal = getRoom(db, roomId)!;
    expect(roomFinal.status).toBe("closed");
    expect(roomFinal.close_reason).toBe("closed");
  });
});

describe("room expiry", () => {
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
    expect(guestStatus.reason).toBe("closed");

    // Verify DB state
    const room = getRoom(db, roomId)!;
    expect(room.status).toBe("closed");
    expect(room.close_reason).toBe("closed");
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
    expect(hostStatus.reason).toBe("closed");
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
    expect(room.close_reason).toBe("closed");
  });
});
