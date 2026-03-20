#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ServerMessage, ClientMessage } from "@agentmeets/shared";

const SERVER_URL =
  process.env.AGENTMEETS_URL?.replace(/\/$/, "") || "http://localhost:3000";

interface MeetState {
  roomId: string;
  token: string;
  role: "host" | "guest";
  ws: WebSocket | null;
  collectingPending: string[] | null;
  pendingReply: {
    resolve: (result: { content: string | null; reason?: string }) => void;
  } | null;
}

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
  reason?: string
): void {
  if (meetState?.pendingReply) {
    const { resolve } = meetState.pendingReply;
    meetState.pendingReply = null;
    resolve({ content, reason });
  }
}

function attachListeners(ws: WebSocket): void {
  ws.addEventListener("message", (event) => {
    let data: ServerMessage;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return; // ignore malformed messages
    }

    switch (data.type) {
      case "message":
        if (meetState?.collectingPending) {
          meetState.collectingPending.push(data.content);
        } else {
          resolvePending(data.content);
        }
        break;
      case "joined":
        break;
      case "ended":
        resolvePending(null, data.reason ?? "closed");
        clearState();
        break;
    }
  });

  ws.addEventListener("close", () => {
    resolvePending(null, "closed");
    meetState = null;
  });

  ws.addEventListener("error", () => {
    resolvePending(null, "closed");
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

const server = new McpServer({
  name: "agentmeets",
  version: "0.1.0",
});

server.tool(
  "create_meet",
  "Create a new AgentMeets room. The server will keep the room open for 5 minutes waiting for a guest to join.",
  {},
  async () => {
    if (meetState) {
      return errorResult("A meet is already active. Call end_meet first.");
    }

    let res: Response;
    try {
      res = await fetch(`${SERVER_URL}/rooms`, { method: "POST" });
    } catch (err) {
      return errorResult(`Cannot reach server at ${SERVER_URL}: ${err}`);
    }

    if (!res.ok) {
      return errorResult(`Server error creating room: ${res.status}`);
    }

    const { roomId, hostToken } = await res.json();

    const ws = new WebSocket(wsUrl(roomId, hostToken));
    meetState = {
      roomId,
      token: hostToken,
      role: "host",
      ws,
      collectingPending: null,
      pendingReply: null,
    };

    attachListeners(ws);

    try {
      await waitForOpen(ws);
    } catch {
      clearState();
      return errorResult("WebSocket connection failed");
    }

    return textResult({ roomId, status: "waiting" });
  }
);

server.tool(
  "join_meet",
  "Join an existing AgentMeets room by room code",
  {
    roomId: z.string().describe("Room code to join"),
  },
  async ({ roomId }) => {
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

    meetState = {
      roomId,
      token: guestToken,
      role: "guest",
      ws,
      collectingPending: pendingMessages,
      pendingReply: null,
    };

    attachListeners(ws);

    try {
      await waitForOpen(ws);
    } catch {
      clearState();
      return errorResult("WebSocket connection failed");
    }

    // Brief window to collect pending messages delivered by the server on connect
    await new Promise((r) => setTimeout(r, 200));

    // Stop collecting — future messages go to pendingReply
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

server.tool(
  "send_and_wait",
  "Send a message and wait for a reply from the other participant",
  {
    message: z.string().describe("Message to send"),
    timeout: z
      .number()
      .optional()
      .default(120)
      .describe("Max seconds to wait for reply"),
  },
  async ({ message, timeout }) => {
    if (!meetState) {
      return errorResult(
        "No active meet. Call create_meet or join_meet first."
      );
    }

    if (!meetState.ws || meetState.ws.readyState !== WebSocket.OPEN) {
      clearState();
      return errorResult("Connection lost");
    }

    const payload: ClientMessage = { type: "message", content: message };
    meetState.ws.send(JSON.stringify(payload));

    const result = await new Promise<{
      content: string | null;
      reason?: string;
    }>((resolve) => {
      meetState!.pendingReply = { resolve };

      setTimeout(() => {
        if (meetState?.pendingReply?.resolve === resolve) {
          meetState.pendingReply = null;
          resolve({ content: null, reason: "timeout" });
        }
      }, timeout * 1000);
    });

    if (result.content !== null) {
      return textResult({ reply: result.content, status: "ok" });
    }

    const reason = result.reason ?? (meetState === null ? "closed" : "timeout");
    clearState();
    return textResult({ reply: null, status: "ended", reason });
  }
);

server.tool(
  "end_meet",
  "End the current meet and disconnect",
  {},
  async () => {
    if (!meetState) {
      return errorResult("No active meet");
    }

    if (meetState.ws && meetState.ws.readyState === WebSocket.OPEN) {
      const payload: ClientMessage = { type: "end" };
      meetState.ws.send(JSON.stringify(payload));
    }

    clearState();

    return textResult({ status: "ended" });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
