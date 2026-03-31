import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMeetController } from "./controller.js";
import { registerMeetTools } from "./register-tools.js";

const env =
  (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env ?? {};
const SERVER_URL =
  env.AGENTMEETS_URL?.replace(/\/$/, "") || "https://api.innies.live";
const SESSION_ADAPTER = env.AGENTMEETS_SESSION_ADAPTER?.trim();

const controller = createMeetController({
  serverUrl: SERVER_URL,
  fetchFn: fetch,
  sessionAdapterName:
    SESSION_ADAPTER === "claude-code" || SESSION_ADAPTER === "codex"
      ? SESSION_ADAPTER
      : undefined,
});

const server = new McpServer({
  name: "agentmeets",
  version: "0.3.10",
});

registerMeetTools(server, controller);

const transport = new StdioServerTransport();
await server.connect(transport);
