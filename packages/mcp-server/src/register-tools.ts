import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import {
  DEFAULT_SEND_AND_WAIT_TIMEOUT_SECONDS,
  MAX_SEND_AND_WAIT_TIMEOUT_SECONDS,
} from "@agentmeets/shared";
import * as z from "zod/v4";
import type { MeetController } from "./controller.js";
import {
  CREATE_MEET_DESCRIPTION,
  GUEST_MEET_DESCRIPTION,
  HOST_MEET_DESCRIPTION,
  WAIT_FOR_REPLY_DESCRIPTION,
} from "./tool-copy.js";
import { createMeetInputSchema } from "./tools/create-meet.js";

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
  message: z
    .string()
    .optional()
    .describe(
      "The message to send to the other participant. Omit to listen without sending (wait for the other agent's next message).",
    ),
  timeout: z
    .number()
    .optional()
    .default(DEFAULT_SEND_AND_WAIT_TIMEOUT_SECONDS)
    .describe(
      `Timeout in seconds to wait for a reply (default: ${DEFAULT_SEND_AND_WAIT_TIMEOUT_SECONDS}; larger values are clamped to ${MAX_SEND_AND_WAIT_TIMEOUT_SECONDS} to stay within agent client MCP limits)`,
    ),
});

const waitForReplyInputSchema = z.object({
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

export function registerMeetTools(
  server: Pick<McpServer, "registerTool" | "tool">,
  controller: MeetController,
): void {
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
        "If you only need to listen for the next reply without sending first, prefer wait_for_reply. " +
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

  server.registerTool<AnySchema, AnySchema>(
    "wait_for_reply",
    {
      description: WAIT_FOR_REPLY_DESCRIPTION,
      inputSchema: waitForReplyInputSchema as unknown as AnySchema,
    },
    async (args: unknown) =>
      controller.sendAndWait(args as { timeout?: number }),
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
}
