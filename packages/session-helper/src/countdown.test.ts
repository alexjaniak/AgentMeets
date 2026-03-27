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

describe("createCountdown", () => {
  test("interrupts the countdown when the operator presses e", async () => {
    const module = await import("./countdown.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    let scheduledCallback: (() => void) | null = null;
    let clearedHandle: object | null = null;
    const timerHandle = { id: "timer-1" };

    const countdown = module.createCountdown({
      durationMs: 120_000,
      setTimeoutFn(callback: () => void) {
        scheduledCallback = callback;
        return timerHandle;
      },
      clearTimeoutFn(handle: object) {
        clearedHandle = handle;
      },
    });

    const resultPromise = countdown.result;
    countdown.handleKeypress("e");

    await expect(resultPromise).resolves.toEqual({
      kind: "interrupted",
      key: "e",
    });
    expect(clearedHandle).toBe(timerHandle);
    expect(scheduledCallback).not.toBeNull();
  });

  test("falls back after 120 seconds when there is no interruption", async () => {
    const module = await import("./countdown.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    let scheduledCallback: (() => void) | null = null;

    const countdown = module.createCountdown({
      durationMs: 120_000,
      setTimeoutFn(callback: () => void) {
        scheduledCallback = callback;
        return { id: "timer-2" };
      },
      clearTimeoutFn() {},
    });

    expect(scheduledCallback).not.toBeNull();
    scheduledCallback?.();

    await expect(countdown.result).resolves.toEqual({
      kind: "expired",
      durationMs: 120_000,
    });
  });

  test("client runtime enters manual draft mode after the countdown expires and persists it", async () => {
    const module = await import("./client.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "agentmeets-session-client-"));
    tempDirs.push(rootDir);

    let scheduledCallback: (() => void) | null = null;
    let timerCount = 0;

    const client = await module.createSessionHelperClient({
      rootDir,
      roomId: "ROOM-123",
      countdownOptions: {
        setTimeoutFn(callback: () => void) {
          scheduledCallback = callback;
          timerCount += 1;
          return { id: `timer-${timerCount}` } as unknown as ReturnType<
            typeof setTimeout
          >;
        },
        clearTimeoutFn() {},
      },
    });

    expect(client.getState().draftMode).toBe("auto");
    expect(timerCount).toBe(1);
    expect(scheduledCallback).not.toBeNull();

    scheduledCallback?.();
    await client.waitForIdle();

    expect(client.getState().draftMode).toBe("manual");
    expect(await client.reload()).toMatchObject({
      draftMode: "manual",
    });

    const rawFile = JSON.parse(
      await readFile(
        join(rootDir, ".context", "agentmeets", "ROOM-123", "state.json"),
        "utf8",
      ),
    );
    expect(rawFile).toMatchObject({
      draftMode: "manual",
    });
  });

  test("client runtime handles e interruption and rearms the countdown after auto mode resumes", async () => {
    const module = await import("./client.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "agentmeets-session-client-"));
    tempDirs.push(rootDir);

    let timerCount = 0;

    const client = await module.createSessionHelperClient({
      rootDir,
      roomId: "ROOM-456",
      countdownOptions: {
        setTimeoutFn() {
          timerCount += 1;
          return { id: `timer-${timerCount}` } as unknown as ReturnType<
            typeof setTimeout
          >;
        },
        clearTimeoutFn() {},
      },
    });

    expect(timerCount).toBe(1);

    await expect(client.handleKeypress("e")).resolves.toEqual([
      {
        kind: "draft_mode_changed",
        draftMode: "manual",
        reason: "interrupted",
      },
    ]);
    expect(client.getState().draftMode).toBe("manual");

    await expect(client.resumeAutoMode()).resolves.toEqual([
      {
        kind: "draft_mode_changed",
        draftMode: "auto",
        reason: "manual_complete",
      },
    ]);
    expect(client.getState().draftMode).toBe("auto");
    expect(timerCount).toBe(2);
  });
});
