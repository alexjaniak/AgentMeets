import {
  formatLiveSmokeSnapshot,
  readLiveSmokeSnapshot,
} from "./lib/inspect-live";

interface CliOptions {
  dbPath: string;
  roomId?: string;
  roomStemOrInvite?: string;
  json: boolean;
  limit?: number;
}

const HELP_TEXT = `Usage:
  bun run smoke:inspect-live -- --db <path> [--invite <url-or-token> | --room-stem <stem> | --room-id <id>] [--limit <n>] [--json]

Examples:
  bun run smoke:inspect-live -- --db .tmp/agentmeets-live-smoke.db
  bun run smoke:inspect-live -- --db .tmp/agentmeets-live-smoke.db --invite http://127.0.0.1:3100/j/r_9wK3mQvH8.2
`;

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const snapshot = readLiveSmokeSnapshot({
    dbPath: options.dbPath,
    roomId: options.roomId,
    roomStemOrInvite: options.roomStemOrInvite,
    limit: options.limit,
  });

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log(formatLiveSmokeSnapshot(snapshot));
}

function parseCliArgs(args: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--db":
        options.dbPath = readValue(args, ++index, "--db");
        break;
      case "--room-id":
        options.roomId = readValue(args, ++index, "--room-id");
        break;
      case "--room-stem":
        options.roomStemOrInvite = readValue(args, ++index, "--room-stem");
        break;
      case "--invite":
        options.roomStemOrInvite = readValue(args, ++index, "--invite");
        break;
      case "--limit":
        options.limit = Number(readValue(args, ++index, "--limit"));
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        console.log(HELP_TEXT);
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.dbPath) {
    throw new Error("--db is required");
  }

  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }

  return options as CliOptions;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error("");
  console.error(HELP_TEXT);
  process.exit(1);
});
