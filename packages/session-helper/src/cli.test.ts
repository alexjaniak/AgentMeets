import { describe, expect, test } from "bun:test";

interface TestCliEnvironment {
  env?: Record<string, string | undefined>;
  stdout: {
    write: (chunk: string) => void;
  };
  stderr: {
    write: (chunk: string) => void;
  };
  openTty: () => number;
  writeTty: (fd: number, chunk: string) => void;
  closeTty: (fd: number) => void;
  createAdapter: (options: {
    adapterName: string;
    writeToPty: (chunk: string) => void;
  }) => {
    injectHostReadyPrompt: (input: { participantLink: string }) => Promise<void>;
    injectGuestReadyPrompt: (input: {
      participantLink: string;
    }) => Promise<void>;
  };
}

function createTestCliEnvironment() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ttyWrites: string[] = [];
  const adapterCalls: Array<{
    mode: "host" | "guest";
    participantLink: string;
  }> = [];
  const adapterNames: string[] = [];

  const environment: TestCliEnvironment = {
    env: {},
    stdout: {
      write(chunk) {
        stdout.push(chunk);
      },
    },
    stderr: {
      write(chunk) {
        stderr.push(chunk);
      },
    },
    openTty() {
      return 99;
    },
    writeTty(_fd, chunk) {
      ttyWrites.push(chunk);
    },
    closeTty() {},
    createAdapter(options) {
      adapterNames.push(options.adapterName);
      return {
        async injectHostReadyPrompt(input) {
          adapterCalls.push({
            mode: "host",
            participantLink: input.participantLink,
          });
        },
        async injectGuestReadyPrompt(input) {
          adapterCalls.push({
            mode: "guest",
            participantLink: input.participantLink,
          });
        },
      };
    },
  };

  return {
    environment,
    stdout,
    stderr,
    ttyWrites,
    adapterCalls,
    adapterNames,
  };
}

describe("session-helper CLI", () => {
  test("host mode injects the host-ready prompt from --participant-link", async () => {
    const module = await import("./cli.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const harness = createTestCliEnvironment();
    const participantLink = "https://agentmeets.test/j/r_9wK3mQvH8.1";

    const exitCode = await (module.main as any)(
      ["host", "--participant-link", participantLink],
      harness.environment,
    );

    expect(exitCode).toBe(0);
    expect(harness.stderr).toEqual([]);
    expect(harness.adapterCalls).toEqual([
      { mode: "host", participantLink },
    ]);
    expect(harness.adapterNames).toEqual(["claude-code"]);
  });

  test("host mode auto-detects Codex when Codex session markers are present", async () => {
    const module = await import("./cli.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const harness = createTestCliEnvironment();
    harness.environment.env = {
      CODEX_THREAD_ID: "thread-123",
    };
    const participantLink = "https://agentmeets.test/j/r_9wK3mQvH8.1";

    const exitCode = await (module.main as any)(
      ["host", "--participant-link", participantLink],
      harness.environment,
    );

    expect(exitCode).toBe(0);
    expect(harness.stderr).toEqual([]);
    expect(harness.adapterCalls).toEqual([
      { mode: "host", participantLink },
    ]);
    expect(harness.adapterNames).toEqual(["codex"]);
  });

  test("guest mode injects the guest-ready prompt from --participant-link", async () => {
    const module = await import("./cli.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const harness = createTestCliEnvironment();
    const participantLink = "https://agentmeets.test/j/r_9wK3mQvH8.2";

    const exitCode = await (module.main as any)(
      ["guest", "--participant-link", participantLink],
      harness.environment,
    );

    expect(exitCode).toBe(0);
    expect(harness.stderr).toEqual([]);
    expect(harness.adapterCalls).toEqual([
      { mode: "guest", participantLink },
    ]);
    expect(harness.adapterNames).toEqual(["claude-code"]);
  });

  test("guest mode auto-detects Codex when Codex session markers are present", async () => {
    const module = await import("./cli.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const harness = createTestCliEnvironment();
    harness.environment.env = {
      CODEX_MANAGED_BY_NPM: "1",
    };
    const participantLink = "https://agentmeets.test/j/r_9wK3mQvH8.2";

    const exitCode = await (module.main as any)(
      ["guest", "--participant-link", participantLink],
      harness.environment,
    );

    expect(exitCode).toBe(0);
    expect(harness.stderr).toEqual([]);
    expect(harness.adapterCalls).toEqual([
      { mode: "guest", participantLink },
    ]);
    expect(harness.adapterNames).toEqual(["codex"]);
  });

  test("help output documents both host and guest bootstrap commands", async () => {
    const module = await import("./cli.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const harness = createTestCliEnvironment();

    const exitCode = await (module.main as any)(["--help"], harness.environment);

    expect(exitCode).toBe(0);
    expect(harness.stdout.join("")).toContain(
      "agentmeets-session host --participant-link <url>",
    );
    expect(harness.stdout.join("")).toContain(
      "agentmeets-session guest --participant-link <url>",
    );
  });
});
