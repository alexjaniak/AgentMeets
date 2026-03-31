import { DEFAULT_SESSION_HELPER_COUNTDOWN_MS } from "@agentmeets/shared";

export const DEFAULT_COUNTDOWN_MS = DEFAULT_SESSION_HELPER_COUNTDOWN_MS;

export interface CreateCountdownOptions {
  durationMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface CountdownController {
  result: Promise<{ kind: "interrupted"; key: "e" } | { kind: "expired"; durationMs: number }>;
  handleKeypress(input: string): boolean;
  cancel(): void;
}

export function createCountdown({
  durationMs = DEFAULT_COUNTDOWN_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: CreateCountdownOptions = {}): CountdownController {
  let settled = false;
  let resolveResult: (
    value: { kind: "interrupted"; key: "e" } | { kind: "expired"; durationMs: number },
  ) => void = () => {};

  const result = new Promise<
    { kind: "interrupted"; key: "e" } | { kind: "expired"; durationMs: number }
  >((resolve) => {
    resolveResult = resolve;
  });

  const timer = setTimeoutFn(() => {
    settle({
      kind: "expired",
      durationMs,
    });
  }, durationMs);

  return {
    result,
    handleKeypress(input) {
      if (settled) {
        return false;
      }

      if (!input.includes("e")) {
        return false;
      }

      clearTimeoutFn(timer);
      settle({
        kind: "interrupted",
        key: "e",
      });
      return true;
    },
    cancel() {
      if (settled) {
        return;
      }

      clearTimeoutFn(timer);
      settled = true;
    },
  };

  function settle(
    value: { kind: "interrupted"; key: "e" } | { kind: "expired"; durationMs: number },
  ) {
    if (settled) {
      return;
    }

    settled = true;
    resolveResult(value);
  }
}
