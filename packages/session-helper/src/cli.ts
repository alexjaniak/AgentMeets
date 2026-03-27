import { closeSync, openSync, writeSync } from "node:fs";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { CodexAdapter } from "./adapters/codex.js";

export type SessionAdapterName = "claude-code" | "codex";

interface HostBootstrapAdapter {
  injectHostReadyPrompt: (input: { participantLink: string }) => Promise<void>;
  injectGuestReadyPrompt: (input: { participantLink: string }) => Promise<void>;
}

interface CreateSessionAdapterOptions {
  adapterName: SessionAdapterName;
  writeToPty: (chunk: string) => void | Promise<void>;
}

interface CliEnvironment {
  env: Record<string, string | undefined>;
  stdout: Pick<typeof process.stdout, "write">;
  stderr: Pick<typeof process.stderr, "write">;
  openTty: () => number;
  writeTty: (fd: number, chunk: string) => void;
  closeTty: (fd: number) => void;
  createAdapter: (
    options: CreateSessionAdapterOptions,
  ) => HostBootstrapAdapter;
}

const HELP_TEXT = `agentmeets-session

Usage:
  agentmeets-session host --participant-link <url> [--adapter claude-code|codex]
  agentmeets-session guest --participant-link <url> [--adapter claude-code|codex]
  agentmeets-session --help

Description:
  Runtime helpers for AgentMeets same-session coordination.
  Persists session state under .context/agentmeets/<roomId>/state.json
  and supports countdown-driven manual draft fallback.
`;

const defaultCliEnvironment: CliEnvironment = {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  openTty() {
    return openSync("/dev/tty", "w");
  },
  writeTty(fd, chunk) {
    writeSync(fd, chunk);
  },
  closeTty(fd) {
    closeSync(fd);
  },
  createAdapter(options) {
    return createSessionAdapter(options);
  },
};

export async function main(
  argv: string[] = process.argv.slice(2),
  environment: CliEnvironment = defaultCliEnvironment,
): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    environment.stdout.write(HELP_TEXT);
    return 0;
  }

  if (argv[0] === "host") {
    return runBootstrap("host", argv.slice(1), environment);
  }

  if (argv[0] === "guest") {
    return runBootstrap("guest", argv.slice(1), environment);
  }

  environment.stderr.write(`Unknown arguments: ${argv.join(" ")}\n\n${HELP_TEXT}`);
  return 1;
}

async function runBootstrap(
  role: "host" | "guest",
  argv: string[],
  environment: CliEnvironment,
): Promise<number> {
  const options = parseFlags(argv);
  const participantLink = options["participant-link"];
  const adapterName = resolveSessionAdapterName(options.adapter, environment.env);

  if (!participantLink) {
    environment.stderr.write(
      `Missing required ${role} argument: --participant-link\n`,
    );
    return 1;
  }

  if (!isSessionAdapterName(adapterName)) {
    environment.stderr.write(`Unsupported adapter: ${adapterName}\n`);
    return 1;
  }

  let ttyFd: number;
  try {
    ttyFd = environment.openTty();
  } catch (error) {
    environment.stderr.write(
      `Cannot open controlling PTY at /dev/tty: ${formatError(error)}\n`,
    );
    return 1;
  }

  try {
    const adapter = environment.createAdapter({
      adapterName,
      writeToPty(chunk) {
        environment.writeTty(ttyFd, chunk);
      },
    });

    if (role === "host") {
      await adapter.injectHostReadyPrompt({
        participantLink,
      });
    } else {
      await adapter.injectGuestReadyPrompt({
        participantLink,
      });
    }
    return 0;
  } finally {
    environment.closeTty(ttyFd);
  }
}

export function createSessionAdapter({
  adapterName,
  writeToPty,
}: CreateSessionAdapterOptions): ClaudeCodeAdapter | CodexAdapter {
  if (adapterName === "codex") {
    return new CodexAdapter({ writeToPty });
  }

  return new ClaudeCodeAdapter({ writeToPty });
}

function parseFlags(argv: string[]): Record<string, string> {
  const options: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      continue;
    }

    options[token.slice(2)] = value;
    index += 1;
  }

  return options;
}

export function resolveSessionAdapterName(
  explicitAdapter: string | undefined,
  env: Record<string, string | undefined>,
): string {
  if (explicitAdapter) {
    return explicitAdapter;
  }

  const configuredAdapter = env.AGENTMEETS_SESSION_ADAPTER?.trim();
  if (configuredAdapter) {
    return configuredAdapter;
  }

  if (hasCodexSessionMarkers(env)) {
    return "codex";
  }

  return "claude-code";
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isSessionAdapterName(value: string): value is SessionAdapterName {
  return value === "claude-code" || value === "codex";
}

function hasCodexSessionMarkers(
  env: Record<string, string | undefined>,
): boolean {
  return Boolean(env.CODEX_THREAD_ID || env.CODEX_MANAGED_BY_NPM);
}

const isDirectExecution = import.meta.url === `file://${process.argv[1]}`;

if (isDirectExecution) {
  const exitCode = await main();
  process.exit(exitCode);
}
