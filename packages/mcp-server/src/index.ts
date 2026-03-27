import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import * as z from "zod/v4";
import { createMeetController } from "./controller.js";
import { createMeetInputSchema } from "./tools/create-meet.js";

const env =
  (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env ?? {};
const SERVER_URL =
  env.AGENTMEETS_URL?.replace(/\/$/, "") || "http://localhost:3000";

const hostMeetInputSchema = z.object({
  participantLink: z
    .string()
    .describe("Host participant invite link returned by create_meet"),
});

const guestMeetInputSchema = z.object({
  participantLink: z
    .string()
    .describe("Guest participant invite link shared by the host"),
});

const sendAndWaitInputSchema = z.object({
  message: z.string().describe("Message to send"),
  timeout: z
    .number()
    .optional()
    .default(120)
    .describe("Max seconds to wait for reply"),
});

const joinMeetInputSchema = z.object({
  roomId: z.string().describe("Room code to join"),
});

const controller = createMeetController({
  serverUrl: SERVER_URL,
  fetchFn: fetch,
});

const server = new McpServer({
  name: "agentmeets",
  version: "0.2.0",
});

server.registerTool<AnySchema, AnySchema>(
  "create_meet",
  {
    description:
      "Create a new AgentMeets room and return the invite link plus host helper bootstrap command.",
    inputSchema: createMeetInputSchema as unknown as AnySchema,
  },
  async (args: unknown) =>
    controller.createMeet(args as { openingMessage: string; inviteTtlSeconds?: number }),
);

server.registerTool<AnySchema, AnySchema>(
  "host_meet",
  {
    description:
      "Claim the host participant link from create_meet and connect this MCP session as the host.",
    inputSchema: hostMeetInputSchema as unknown as AnySchema,
  },
  async (args: unknown) =>
    controller.hostMeet(args as { participantLink: string }),
);

server.registerTool<AnySchema, AnySchema>(
  "guest_meet",
  {
    description:
      "Claim the guest participant invite link and connect this MCP session as the guest.",
    inputSchema: guestMeetInputSchema as unknown as AnySchema,
  },
  async (args: unknown) =>
    controller.guestMeet(args as { participantLink: string }),
);

server.registerTool<AnySchema, AnySchema>(
  "join_meet",
  {
    description: "Join an existing room by room code",
    inputSchema: joinMeetInputSchema as unknown as AnySchema,
  },
  async (args: unknown) =>
    controller.joinMeet(args as { roomId: string }),
);

server.registerTool<AnySchema, AnySchema>(
  "send_and_wait",
  {
    description: "Send a message and wait for a reply from the other participant",
    inputSchema: sendAndWaitInputSchema as unknown as AnySchema,
  },
  async (args: unknown) =>
    controller.sendAndWait(args as { message: string; timeout: number }),
);

server.tool(
  "end_meet",
  "End the current meet and disconnect",
  {},
  async () => controller.endMeet(),
);

const transport = new StdioServerTransport();
await server.connect(transport);
