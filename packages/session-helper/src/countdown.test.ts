import { describe, expect, test } from "bun:test";

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
});
