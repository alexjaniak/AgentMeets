import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ManagedProcess {
  name: string;
  stop(): Promise<void>;
}

export async function waitForHttpReady(
  url: string,
  timeoutMs = 10_000,
  isReady: (response: Response) => boolean = (response) => response.ok,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (isReady(response)) {
        return;
      }
    } catch {
      // Keep polling until the timeout expires.
    }

    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

export async function createSmokeDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

export function startManagedProcess(
  name: string,
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
): ManagedProcess {
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stdio: "ignore",
  });

  return {
    name,
    async stop() {
      if (child.exitCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
    },
  };
}
