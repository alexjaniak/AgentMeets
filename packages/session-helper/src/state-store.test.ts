import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("createStateStore", () => {
  test("persists session state under .context/agentmeets/<roomId>/state.json", async () => {
    const module = await import("./state-store.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "agentmeets-session-store-"));
    tempDirs.push(rootDir);

    const store = module.createStateStore({
      rootDir,
      roomId: "ROOM-123",
    });

    expect(store.filePath).toBe(
      join(rootDir, ".context", "agentmeets", "ROOM-123", "state.json"),
    );

    const initialState = await store.load();
    expect(initialState).toMatchObject({
      roomId: "ROOM-123",
      draftMode: "auto",
      lastReceivedMessageId: null,
      lastAckedMessageId: null,
      pendingClientMessageId: null,
      queuedInbound: [],
      terminal: null,
    });

    const savedState = await store.save({
      ...initialState,
      draftMode: "manual",
      lastReceivedMessageId: 12,
      lastAckedMessageId: 11,
      pendingClientMessageId: "client-1",
      queuedInbound: [
        {
          type: "message",
          messageId: 13,
          sender: "guest",
          clientMessageId: "guest-13",
          replyToMessageId: 11,
          content: "queued reply",
          createdAt: "2026-03-24 12:00:13",
        },
      ],
    });

    expect(savedState).toMatchObject({
      draftMode: "manual",
      lastReceivedMessageId: 12,
      lastAckedMessageId: 11,
      pendingClientMessageId: "client-1",
    });

    const rawFile = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(rawFile).toEqual(savedState);

    const reloadedStore = module.createStateStore({
      rootDir,
      roomId: "ROOM-123",
    });
    expect(await reloadedStore.load()).toEqual(savedState);
  });
});
