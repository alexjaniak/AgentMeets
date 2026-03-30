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
  env.AGENTMEETS_URL?.replace(/\/$/, "") || "https://api.innies.live";

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
  message: z.string().describe("The message to send to the other participant"),
  timeout: z
    .number()
    .optional()
    .default(300)
    .describe("Timeout in seconds to wait for a reply (default: 300)"),
});


const controller = createMeetController({
  serverUrl: SERVER_URL,
  fetchFn: fetch,
});

const server = new McpServer({
  name: "agentmeets",
  version: "0.3.7",
});

server.registerTool<AnySchema, AnySchema>(
  "create_meet",
  {
    description:
      "Create a new AgentMeets room and return its room label plus copy-ready invite instructions for both agents.",
    inputSchema: createMeetInputSchema as unknown as AnySchema,
  },
  async (args: unknown) =>
    controller.createMeet(args as { openingMessage: string; inviteTtlSeconds?: number }),
);

server.registerTool<AnySchema, AnySchema>(
  "host_meet",
  {
    description:
      "Claim the host participant link and connect this MCP session as the host. " +
      "The participantLink is a URL matching the pattern: innies.live/j/<stem>.1 " +
      "(or any AgentMeets server URL ending in .1). " +
      "If the user pastes a message containing a URL matching this pattern, " +
      "call this tool automatically with that URL as participantLink. " +
      "After connecting, immediately call send_and_wait to begin the conversation. " +
      "Continue calling send_and_wait in a loop to keep the conversation going autonomously " +
      "until the other agent ends the session or it times out. Do NOT stop and ask the user " +
      "what to say — generate your own responses based on the conversation context. " +
      "Keep your messages concise and to the point — no essays, no filler.",
    inputSchema: hostMeetInputSchema as unknown as AnySchema,
    annotations: { readOnlyHint: false },
  },
  async (args: unknown) =>
    controller.hostMeet(args as { participantLink: string }),
);

server.registerTool<AnySchema, AnySchema>(
  "guest_meet",
  {
    description:
      "Claim the guest participant invite link and connect this MCP session as the guest. " +
      "The participantLink is a URL matching the pattern: innies.live/j/<stem>.2 " +
      "(or any AgentMeets server URL ending in .2). " +
      "If the user pastes a message containing a URL matching this pattern, " +
      "call this tool automatically with that URL as participantLink. " +
      "After connecting, you will receive the opening message in the pending array. " +
      "Immediately call send_and_wait to respond and keep calling it in a loop to continue " +
      "the conversation autonomously until the other agent ends the session or it times out. " +
      "Do NOT stop and ask the user what to say — generate your own responses based on the conversation context. " +
      "Keep your messages concise and to the point — no essays, no filler.",
    inputSchema: guestMeetInputSchema as unknown as AnySchema,
    annotations: { readOnlyHint: false },
  },
  async (args: unknown) =>
    controller.guestMeet(args as { participantLink: string }),
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
    annotations: { readOnlyHint: false },
  },
  async (args: unknown) =>
    controller.sendAndWait(args as { message: string; timeout?: number }),
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
