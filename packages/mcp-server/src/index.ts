import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import * as z from "zod/v4";
import { createEndPayload, createMeetState, createMessagePayload, processServerMessage } from "./client.js";
import type { PendingReplyResult, MeetState } from "./client.js";
import { createCreateMeetHandler, createMeetInputSchema } from "./tools/create-meet.js";

const env =
  (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env ?? {};
const SERVER_URL =
  env.AGENTMEETS_URL?.replace(/\/$/, "") || "http://localhost:3000";

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

let meetState: MeetState | null = null;

function wsUrl(roomId: string, token: string): string {
  const base = SERVER_URL.replace(/^http/, "ws");
  return `${base}/rooms/${roomId}/ws?token=${token}`;
}

function clearState(): void {
  if (meetState?.ws) {
    try {
      meetState.ws.close();
    } catch {}
  }
  meetState = null;
}

function resolvePending(
  content: string | null,
  reason?: PendingReplyResult["reason"],
  error?: PendingReplyResult["error"],
): void {
  if (meetState?.pendingReply) {
    const { resolve } = meetState.pendingReply;
    meetState.pendingReply = null;
    resolve({ content, reason, error });
  }
}

function attachListeners(ws: WebSocket): void {
  ws.addEventListener("message", (event) => {
    if (!meetState) {
      return;
    }

    try {
      const result = processServerMessage(
        meetState,
        JSON.parse(String(event.data)),
      );

      switch (result.kind) {
        case "message":
          if (meetState.collectingPending) {
            meetState.collectingPending.push(result.content);
          } else {
            resolvePending(result.content);
          }
          break;
        case "error":
          resolvePending(null, undefined, {
            code: result.code,
            message: result.message,
          });
          break;
        case "ended":
          resolvePending(null, result.reason);
          clearState();
          break;
        case "none":
          break;
      }
    } catch {
      return; // ignore malformed messages
    }
  });

  ws.addEventListener("close", () => {
    resolvePending(null, "disconnected");
    meetState = null;
  });

  ws.addEventListener("error", () => {
    resolvePending(null, "disconnected");
    meetState = null;
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (e) => reject(e), { once: true });
  });
}

function errorResult(msg: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
    isError: true,
  };
}

function textResult(data: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

const createMeetHandler = createCreateMeetHandler({
  serverUrl: SERVER_URL,
  fetchFn: fetch,
  hasActiveMeet: () => meetState !== null,
});

const sendAndWaitHandler = async ({
  message,
  timeout,
}: {
  message: string;
  timeout: number;
}) => {
  if (!meetState) {
    return errorResult(
      "No active meet. Call create_meet or join_meet first."
    );
  }

  if (!meetState.ws || meetState.ws.readyState !== WebSocket.OPEN) {
    clearState();
    return errorResult("Connection lost");
  }

  const activeMeet = meetState;
  const payload = createMessagePayload(activeMeet, message);

  const result = await new Promise<PendingReplyResult>((resolve) => {
    const finish = (value: PendingReplyResult) => resolve(value);
    activeMeet.pendingReply = { resolve: finish };

    const timer = setTimeout(() => {
      if (activeMeet.pendingReply?.resolve === finish) {
        activeMeet.pendingReply = null;
        finish({ content: null, reason: "timeout" });
      }
    }, timeout * 1000);

    try {
      activeMeet.ws!.send(JSON.stringify(payload));
    } catch {
      clearTimeout(timer);
      if (activeMeet.pendingReply?.resolve === finish) {
        activeMeet.pendingReply = null;
      }
      finish({ content: null, reason: "disconnected" });
    }
  });

  if (result.error) {
    return errorResult(
      `WebSocket protocol error (${result.error.code}): ${result.error.message}`
    );
  }

  if (result.content !== null) {
    return textResult({ reply: result.content, status: "ok" });
  }

  const reason =
    result.reason ?? (meetState === null ? "disconnected" : "timeout");
  clearState();
  return textResult({ reply: null, status: "ended", reason });
};

const endMeetHandler = async () => {
  if (!meetState) {
    return errorResult("No active meet");
  }

  if (meetState.ws && meetState.ws.readyState === WebSocket.OPEN) {
    const payload = createEndPayload();
    meetState.ws.send(JSON.stringify(payload));
  }

  clearState();

  return textResult({ status: "ended" });
};

const server = new McpServer({
  name: "agentmeets",
  version: "0.1.0",
});

server.registerTool<AnySchema, AnySchema>(
  "create_meet",
  {
    description:
      "Create a new AgentMeets room and return the invite link plus host helper bootstrap command.",
    // The MCP SDK validates through its own zod-compat boundary; keep the cast local.
    inputSchema: createMeetInputSchema as unknown as AnySchema,
  },
  async (args: unknown) =>
    createMeetHandler(args as { openingMessage: string; inviteTtlSeconds?: number })
);

server.registerTool<AnySchema, AnySchema>(
  "join_meet",
  {
    description: "Join an existing AgentMeets room by room code",
    inputSchema: joinMeetInputSchema as unknown as AnySchema,
  },
  async (args: unknown) => {
    const { roomId } = args as { roomId: string };
    if (meetState) {
      return errorResult("A meet is already active. Call end_meet first.");
    }

    let res: Response;
    try {
      res = await fetch(`${SERVER_URL}/rooms/${roomId}/join`, {
        method: "POST",
      });
    } catch (err) {
      return errorResult(`Cannot reach server at ${SERVER_URL}: ${err}`);
    }

    if (!res.ok) {
      const statusErrors: Record<number, string> = {
        404: "Room not found",
        409: "Room is full",
        410: "Room has expired",
      };
      return errorResult(
        statusErrors[res.status] ?? `Server error: ${res.status}`
      );
    }

    const { guestToken } = await res.json();

    const pendingMessages: string[] = [];
    const ws = new WebSocket(wsUrl(roomId, guestToken));

    meetState = createMeetState(
      roomId,
      guestToken,
      "guest",
      ws,
      pendingMessages,
    );

    attachListeners(ws);

    try {
      await waitForOpen(ws);
    } catch {
      clearState();
      return errorResult("WebSocket connection failed");
    }

    await new Promise((r) => setTimeout(r, 200));

    if (meetState) {
      meetState.collectingPending = null;
    }

    return textResult({
      roomId,
      status: "connected",
      pending: pendingMessages,
    });
  }
);

server.registerTool<AnySchema, AnySchema>(
  "send_and_wait",
  {
    description: "Send a message and wait for a reply from the other participant",
    inputSchema: sendAndWaitInputSchema as unknown as AnySchema,
  },
  async (args: unknown) =>
    sendAndWaitHandler(args as { message: string; timeout: number })
);

server.tool(
  "end_meet",
  "End the current meet and disconnect",
  {},
  endMeetHandler
);

const transport = new StdioServerTransport();
await server.connect(transport);
