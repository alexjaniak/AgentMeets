import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateRoom,
  claimInvite,
  createDatabase,
  createInvite,
  createRoom,
  saveMessage,
} from "../../../packages/server/src/db/index";
import {
  formatLiveSmokeSnapshot,
  readLiveSmokeSnapshot,
  resolveRoomStemFilter,
} from "./inspect-live";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { force: true, recursive: true });
    }
  }
});

describe("resolveRoomStemFilter", () => {
  test("accepts a room stem directly", () => {
    expect(resolveRoomStemFilter("r_9wK3mQvH8")).toBe("r_9wK3mQvH8");
  });

  test("extracts the room stem from an invite link", () => {
    expect(resolveRoomStemFilter("http://127.0.0.1:3100/j/r_9wK3mQvH8.2")).toBe("r_9wK3mQvH8");
  });
});

describe("readLiveSmokeSnapshot", () => {
  test("returns room state, invite claim state, and persisted messages for a filtered room", async () => {
    const dbPath = await createFixtureDb();

    const snapshot = readLiveSmokeSnapshot({
      dbPath,
      roomStemOrInvite: "http://127.0.0.1:3100/j/r_9wK3mQvH8.2",
    });

    expect(snapshot.dbPath).toBe(dbPath);
    expect(snapshot.rooms).toHaveLength(1);

    const [room] = snapshot.rooms;
    expect(room.roomId).toBe("ABC123");
    expect(room.roomStem).toBe("r_9wK3mQvH8");
    expect(room.status).toBe("active");
    expect(room.invites).toEqual([
      {
        participantRole: "guest",
        expiresAt: "2099-03-26T12:05:00.000Z",
        claimedAt: "2026-03-26T12:01:00.000Z",
        hasSessionToken: true,
      },
      {
        participantRole: "host",
        expiresAt: "2099-03-26T12:05:00.000Z",
        claimedAt: "2026-03-26T12:00:30.000Z",
        hasSessionToken: true,
      },
    ]);
    expect(room.messages.map((message) => [message.sender, message.content])).toEqual([
      ["host", "Smoke test: reply with guest ready"],
      ["guest", "guest ready"],
      ["host", "host saw guest ready"],
    ]);
  });

  test("returns the most recent rooms when no filter is provided", async () => {
    const dbPath = await createFixtureDb();

    const snapshot = readLiveSmokeSnapshot({ dbPath, limit: 1 });

    expect(snapshot.rooms).toHaveLength(1);
    expect(snapshot.rooms[0]?.roomId).toBe("ABC123");
  });
});

describe("formatLiveSmokeSnapshot", () => {
  test("renders a readable summary for operators", async () => {
    const dbPath = await createFixtureDb();
    const snapshot = readLiveSmokeSnapshot({ dbPath });
    const text = formatLiveSmokeSnapshot(snapshot);

    expect(text).toContain(`DB: ${dbPath}`);
    expect(text).toContain("Room ABC123 (r_9wK3mQvH8)");
    expect(text).toContain("status: active");
    expect(text).toContain("guest | claimed=yes | sessionToken=yes");
    expect(text).toContain("1. [host]");
    expect(text).toContain("guest ready");
  });
});

async function createFixtureDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentmeets-live-smoke-"));
  tempDirs.push(dir);

  const dbPath = join(dir, "agentmeets.db");
  const db = createDatabase(dbPath);

  createRoom(
    db,
    "ABC123",
    "host-session-token",
    "Smoke test: reply with guest ready",
    "r_9wK3mQvH8",
  );
  createInvite(db, "ABC123", "r_9wK3mQvH8.1", "2099-03-26T12:05:00.000Z");
  createInvite(db, "ABC123", "r_9wK3mQvH8.2", "2099-03-26T12:05:00.000Z");
  claimInvite(db, "r_9wK3mQvH8.1", "host-claim");
  claimInvite(db, "r_9wK3mQvH8.2", "guest-claim");
  activateRoom(db, "ABC123");
  db.prepare("UPDATE invites SET claimed_at = ? WHERE participant_role = 'host'").run(
    "2026-03-26T12:00:30.000Z",
  );
  db.prepare("UPDATE invites SET claimed_at = ? WHERE participant_role = 'guest'").run(
    "2026-03-26T12:01:00.000Z",
  );
  saveMessage(db, "ABC123", "guest", "guest ready");
  saveMessage(db, "ABC123", "host", "host saw guest ready");
  db.close();

  return dbPath;
}
