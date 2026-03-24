const HELP_TEXT = `agentmeets-session

Usage:
  agentmeets-session --help

Description:
  Runtime helpers for AgentMeets same-session coordination.
  Persists session state under .context/agentmeets/<roomId>/state.json
  and supports countdown-driven manual draft fallback.
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  process.stderr.write(`Unknown arguments: ${argv.join(" ")}\n\n${HELP_TEXT}`);
  return 1;
}

const isDirectExecution = import.meta.url === `file://${process.argv[1]}`;

if (isDirectExecution) {
  const exitCode = await main();
  process.exit(exitCode);
}
