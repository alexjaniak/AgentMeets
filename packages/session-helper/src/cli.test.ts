import { describe, expect, test } from "bun:test";

interface TestCliEnvironment {
  stdout: {
    write: (chunk: string) => void;
  };
  stderr: {
    write: (chunk: string) => void;
  };
  openTty: () => number;
  writeTty: (fd: number, chunk: string) => void;
  closeTty: (fd: number) => void;
  createAdapter: () => {
    injectHostReadyPrompt: (input: { participantLink: string }) => Promise<void>;
  };
}

function createTestCliEnvironment() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ttyWrites: string[] = [];
  const adapterInputs: Array<{ participantLink: string }> = [];

  const environment: TestCliEnvironment = {
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
    createAdapter() {
      return {
        async injectHostReadyPrompt(input) {
          adapterInputs.push(input);
        },
      };
    },
  };

  return {
    environment,
    stdout,
    stderr,
    ttyWrites,
    adapterInputs,
  };
}

describe("session-helper CLI", () => {
  test("host mode requires --participant-link instead of --host-token", async () => {
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
    expect(harness.adapterInputs).toEqual([{ participantLink }]);
  });

  test("help output documents host bootstrap from the role-scoped link", async () => {
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
  });
});
