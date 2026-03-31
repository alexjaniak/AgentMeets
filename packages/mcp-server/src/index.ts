import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import {
  DEFAULT_SEND_AND_WAIT_TIMEOUT_SECONDS,
  MAX_SEND_AND_WAIT_TIMEOUT_SECONDS,
} from "@agentmeets/shared";
import * as z from "zod/v4";
import { createMeetController } from "./controller.js";
import {
  CREATE_MEET_DESCRIPTION,
  GUEST_MEET_DESCRIPTION,
  HOST_MEET_DESCRIPTION,
} from "./tool-copy.js";
import { createMeetInputSchema } from "./tools/create-meet.js";

const env =
  (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env ?? {};
const SERVER_URL =
  env.AGENTMEETS_URL?.replace(/\/$/, "") || "https://api.innies.live";
const SESSION_ADAPTER = env.AGENTMEETS_SESSION_ADAPTER?.trim();

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
  message: z.string().optional().describe("The message to send to the other participant. Omit to listen without sending (wait for the other agent's next message)."),
  timeout: z
    .number()
    .optional()
    .default(DEFAULT_SEND_AND_WAIT_TIMEOUT_SECONDS)
    .describe(
      `Timeout in seconds to wait for a reply (default: ${DEFAULT_SEND_AND_WAIT_TIMEOUT_SECONDS}; larger values are clamped to ${MAX_SEND_AND_WAIT_TIMEOUT_SECONDS} to stay within agent client MCP limits)`,
    ),
});
const joinMeetInputSchema = z.object({
  roomId: z.string().describe("Room code to join"),
});

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
  version: "0.3.9",
});

server.registerTool<AnySchema, AnySchema>(
  "create_meet",
  {
    description: CREATE_MEET_DESCRIPTION,
    inputSchema: createMeetInputSchema as unknown as AnySchema,
  },
  async (args: unknown) =>
    controller.createMeet(args as { openingMessage: string; inviteTtlSeconds?: number }),
);

server.registerTool<AnySchema, AnySchema>(
  "host_meet",
  {
    description: HOST_MEET_DESCRIPTION,
    inputSchema: hostMeetInputSchema as unknown as AnySchema,
  },
  async (args: unknown) =>
    controller.hostMeet(args as { participantLink: string }),
);

server.registerTool<AnySchema, AnySchema>(
  "guest_meet",
  {
    description: GUEST_MEET_DESCRIPTION,
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
    description:
      "Send a message to the other participant and wait for their reply. " +
      "After connecting with host_meet or guest_meet, use this tool to respond to any pending messages " +
      "and to continue the conversation. Returns the reply message when received, " +
      "or ends if the session closes or times out. " +
      "IMPORTANT: Keep calling this tool in a loop after each reply to maintain an autonomous " +
      "back-and-forth conversation. Do NOT ask the user what to say next — generate your own " +
      "responses based on the conversation context and the opening message. " +
      "Keep your messages concise and to the point — no essays, no filler. " +
      "Only stop when the session ends, times out, or you decide the conversation is complete " +
      "(then call end_meet).",
    inputSchema: sendAndWaitInputSchema as unknown as AnySchema,
  },
  async (args: unknown) =>
    controller.sendAndWait(args as { message?: string; timeout?: number }),
);
server.tool(
  "end_meet",
  "End the current meet and disconnect. " +
    "After ending, ALWAYS present your human user with a summary of the conversation including: " +
    "1) Key conclusions or decisions reached, " +
    "2) Action items for either party, if any. " +
    "Format this clearly so the user can quickly see what came out of the conversation.",
  {},
  async () => controller.endMeet(),
);

const transport = new StdioServerTransport();
await server.connect(transport);
