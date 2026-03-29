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
  message: z.string().describe("The message to stage for review before sending"),
  timeout: z
    .number()
    .optional()
    .default(120)
    .describe("Timeout in seconds for waiting after confirm_send (default: 120)"),
});

const confirmSendInputSchema = z.object({
  draftId: z.string().describe("The draftId from the send_and_wait staging result"),
  timeout: z
    .number()
    .optional()
    .default(120)
    .describe("Timeout in seconds to wait for the other participant's reply (default: 120)"),
});

const reviseDraftInputSchema = z.object({
  draftId: z.string().describe("The draftId from the send_and_wait staging result"),
  revisedMessage: z.string().describe("The updated message content"),
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
  "send_and_wait",
  {
    description:
      "Stage a draft message for review. Does NOT send immediately. " +
      "The draft is shown to the human for approval. After staging, wait approximately 5 seconds " +
      "(as indicated by holdSeconds in the response), then call confirm_send to deliver it. " +
      "If the human says anything during the hold (edit request, feedback, 'change X'), " +
      "use revise_draft instead of confirm_send. " +
      "If the human says 'send it' or similar, call confirm_send immediately without waiting.",
    inputSchema: sendAndWaitInputSchema as unknown as AnySchema,
    annotations: { readOnlyHint: false },
  },
  async (args: unknown) =>
    controller.sendAndWait(args as { message: string; timeout?: number }),
);

server.registerTool<AnySchema, AnySchema>(
  "confirm_send",
  {
    description:
      "Send the staged draft and wait for the other participant's reply. " +
      "Call this after the human approves the draft (or after the ~5-second hold with no intervention). " +
      "Returns the other participant's reply message.",
    inputSchema: confirmSendInputSchema as unknown as AnySchema,
    annotations: { readOnlyHint: false },
  },
  async (args: unknown) =>
    controller.confirmSend(args as { draftId: string; timeout?: number }),
);

server.registerTool<AnySchema, AnySchema>(
  "revise_draft",
  {
    description:
      "Revise the staged draft content. Use this when the human wants changes before sending. " +
      "After revising, show the updated draft to the human and wait for approval before calling confirm_send.",
    inputSchema: reviseDraftInputSchema as unknown as AnySchema,
    annotations: { readOnlyHint: false },
  },
  async (args: unknown) =>
    controller.reviseDraft(args as { draftId: string; revisedMessage: string }),
);

server.tool(
  "end_meet",
  "End the current meet and disconnect",
  {},
  async () => controller.endMeet(),
);

const transport = new StdioServerTransport();
await server.connect(transport);
