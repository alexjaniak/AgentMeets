import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

const DEFAULT_SESSION_HELPER_PACKAGE = "@mp-labs/agentmeets-session";

export const createMeetInputSchema = z.object({
  openingMessage: z
    .string()
    .describe("Required opening message to persist and replay to the guest"),
  inviteTtlSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional invite lifetime in seconds"),
});

export interface CreateMeetHandlerOptions {
  serverUrl: string;
  fetchFn?: typeof fetch;
  hasActiveMeet?: () => boolean;
  sessionHelperPackageName?: string;
}

interface CreateMeetArgs {
  openingMessage: string;
  inviteTtlSeconds?: number;
}

interface CreateRoomResponse {
  roomId: string;
  roomStem: string;
  hostAgentLink: string;
  guestAgentLink: string;
  inviteExpiresAt: string;
  status: "waiting_for_join";
}

type ToolResult = CallToolResult;

export function createCreateMeetHandler({
  serverUrl,
  fetchFn = fetch,
  hasActiveMeet = () => false,
  sessionHelperPackageName = DEFAULT_SESSION_HELPER_PACKAGE,
}: CreateMeetHandlerOptions) {
  return async ({
    openingMessage,
    inviteTtlSeconds,
  }: CreateMeetArgs): Promise<ToolResult> => {
    if (hasActiveMeet()) {
      return errorResult("A meet is already active. Call end_meet first.");
    }

    const normalizedOpeningMessage = openingMessage.trim();
    if (normalizedOpeningMessage.length === 0) {
      return errorResult("openingMessage must be a non-empty string");
    }

    let res: Response;
    try {
      res = await fetchFn(`${serverUrl}/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          openingMessage: normalizedOpeningMessage,
          ...(inviteTtlSeconds === undefined ? {} : { inviteTtlSeconds }),
        }),
      });
    } catch (err) {
      return errorResult(`Cannot reach server at ${serverUrl}: ${err}`);
    }

    if (!res.ok) {
      if (res.status === 400) {
        return errorResult("openingMessage must be a non-empty string");
      }
      return errorResult(`Server error creating room: ${res.status}`);
    }

    const data = (await res.json()) as CreateRoomResponse;
    return textResult({
      roomId: data.roomId,
      yourAgentLink: data.hostAgentLink,
      otherAgentLink: data.guestAgentLink,
      shareText: `Tell the other agent to join this chat: ${data.guestAgentLink}`,
      hostHelperCommand: buildHostHelperCommand({
        serverUrl,
        participantLink: data.hostAgentLink,
        sessionHelperPackageName,
      }),
      status: data.status,
    });
  };
}

export interface BuildHostHelperCommandOptions {
  serverUrl: string;
  participantLink: string;
  sessionHelperPackageName?: string;
}

export function buildHostHelperCommand({
  serverUrl,
  participantLink,
  sessionHelperPackageName = DEFAULT_SESSION_HELPER_PACKAGE,
}: BuildHostHelperCommandOptions): string {
  return [
    `AGENTMEETS_URL=${quoteShellArg(serverUrl)}`,
    "npx",
    "-y",
    sessionHelperPackageName,
    "host",
    "--participant-link",
    quoteShellArg(participantLink),
  ].join(" ");
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function textResult(data: object): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
