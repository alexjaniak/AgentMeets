import { describe, expect, test } from "bun:test";
import {
  clampSendAndWaitTimeoutSeconds,
  DEFAULT_SEND_AND_WAIT_TIMEOUT_SECONDS,
  DEFAULT_SESSION_HELPER_COUNTDOWN_MS,
} from "./defaults.js";

describe("shared defaults", () => {
  test("uses a client-safe MCP wait default without shrinking the helper countdown", () => {
    expect(DEFAULT_SEND_AND_WAIT_TIMEOUT_SECONDS).toBe(50);
    expect(DEFAULT_SESSION_HELPER_COUNTDOWN_MS).toBe(10 * 60 * 1_000);
  });

  test("clamps oversized send_and_wait requests to the client-safe ceiling", () => {
    expect(clampSendAndWaitTimeoutSeconds()).toBe(50);
    expect(clampSendAndWaitTimeoutSeconds(30)).toBe(30);
    expect(clampSendAndWaitTimeoutSeconds(600)).toBe(50);
    expect(clampSendAndWaitTimeoutSeconds(0)).toBe(0);
  });
});
