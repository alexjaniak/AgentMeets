import { createEndPayload, createMeetState, createMessagePayload, processServerMessage } from "./client.js";
import type { PendingReplyResult, MeetState } from "./client.js";
import { createCreateMeetHandler } from "./tools/create-meet.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type Sender = "host" | "guest";

interface JoinMeetResponse {
  guestToken: string;
}

interface ClaimInviteResponse {
  roomId: string;
  role: Sender;
  sessionToken: string;
  status: "activating";
}

interface WebSocketLike {
  readonly readyState: number;
  addEventListener: (
    type: string,
    listener: (event: any) => void,
    options?: { once?: boolean },
  ) => void;
  send: (payload: string) => void;
  close: (code?: number, reason?: string) => void;
}

export interface CreateMeetControllerOptions {
  serverUrl: string;
  fetchFn?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocketLike;
  settleDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface MeetController {
  createMeet: ReturnType<typeof createCreateMeetHandler>;
  hostMeet(input: { participantLink: string }): Promise<ToolResult>;
  guestMeet(input: { participantLink: string }): Promise<ToolResult>;
  joinMeet(input: { roomId: string }): Promise<ToolResult>;
  sendAndWait(input: { message: string; timeout: number }): Promise<ToolResult>;
  endMeet(): Promise<ToolResult>;
  getMeetState(): MeetState | null;
}

const DEFAULT_SETTLE_DELAY_MS = 200;
const CLAIM_IDEMPOTENCY_PREFIX: Record<Sender, string> = {
  host: "agentmeets-host:",
  guest: "agentmeets-guest:",
};

export function createMeetController({
  serverUrl,
  fetchFn = fetch,
  webSocketFactory = (url) => new WebSocket(url),
  settleDelayMs = DEFAULT_SETTLE_DELAY_MS,
  sleepFn = defaultSleep,
}: CreateMeetControllerOptions): MeetController {
  let meetState: MeetState | null = null;

  const createMeet = createCreateMeetHandler({
    serverUrl,
    fetchFn,
    hasActiveMeet: () => meetState !== null,
  });

  return {
    createMeet,
    hostMeet,
    guestMeet,
    joinMeet,
    sendAndWait,
    endMeet,
    getMeetState() {
      return meetState;
    },
  };

  async function hostMeet({
    participantLink,
  }: {
    participantLink: string;
  }): Promise<ToolResult> {
    return claimParticipantLink(participantLink, "host");
  }

  async function guestMeet({
    participantLink,
  }: {
    participantLink: string;
  }): Promise<ToolResult> {
    return claimParticipantLink(participantLink, "guest");
  }

  async function claimParticipantLink(
    participantLink: string,
    expectedRole: Sender,
  ): Promise<ToolResult> {
    if (meetState) {
      return errorResult("A meet is already active. Call end_meet first.");
    }

    const parsedInvite = parseParticipantLink(participantLink, expectedRole);
    if ("error" in parsedInvite) {
      return errorResult(parsedInvite.error);
    }

    let res: Response;
    try {
      res = await fetchFn(
        `${parsedInvite.baseUrl}/invites/${parsedInvite.inviteToken}/claim`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": `${CLAIM_IDEMPOTENCY_PREFIX[expectedRole]}${parsedInvite.inviteToken}`,
          },
        },
      );
    } catch (err) {
      return errorResult(`Cannot reach server at ${parsedInvite.baseUrl}: ${err}`);
    }

    if (!res.ok) {
      const statusErrors: Record<number, string> = {
        404: "Invite not found",
        409: "Invite has already been claimed",
        410: "Invite has expired",
      };
      return errorResult(
        statusErrors[res.status] ?? `Server error claiming invite: ${res.status}`,
      );
    }

    const claim = (await res.json()) as ClaimInviteResponse;
    if (claim.role !== expectedRole) {
      return errorResult(roleInviteError(expectedRole));
    }

    return connectMeet({
      activeServerUrl: parsedInvite.baseUrl,
      roomId: claim.roomId,
      token: claim.sessionToken,
      role: claim.role,
    });
  }

  async function joinMeet({
    roomId,
  }: {
    roomId: string;
  }): Promise<ToolResult> {
    if (meetState) {
      return errorResult("A meet is already active. Call end_meet first.");
    }

    let res: Response;
    try {
      res = await fetchFn(`${serverUrl}/rooms/${roomId}/join`, {
        method: "POST",
      });
    } catch (err) {
      return errorResult(`Cannot reach server at ${serverUrl}: ${err}`);
    }

    if (!res.ok) {
      const statusErrors: Record<number, string> = {
        404: "Room not found",
        409: "Room is full",
        410: "Room has expired",
      };
      return errorResult(
        statusErrors[res.status] ?? `Server error: ${res.status}`,
      );
    }

    const { guestToken } = (await res.json()) as JoinMeetResponse;
    return connectMeet({
      activeServerUrl: serverUrl,
      roomId,
      token: guestToken,
      role: "guest",
    });
  }

  async function sendAndWait({
    message,
    timeout,
  }: {
    message: string;
    timeout: number;
  }): Promise<ToolResult> {
    if (!meetState) {
      return errorResult(
        "No active meet. Call create_meet, host_meet, guest_meet, or join_meet first.",
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
      }, timeout * 1_000);

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
        `WebSocket protocol error (${result.error.code}): ${result.error.message}`,
      );
    }

    if (result.content !== null) {
      return textResult({ reply: result.content, status: "ok" });
    }

    const reason =
      result.reason ?? (meetState === null ? "disconnected" : "timeout");
    clearState();
    return textResult({ reply: null, status: "ended", reason });
  }

  async function endMeet(): Promise<ToolResult> {
    if (!meetState) {
      return errorResult("No active meet");
    }

    if (meetState.ws && meetState.ws.readyState === WebSocket.OPEN) {
      const payload = createEndPayload();
      meetState.ws.send(JSON.stringify(payload));
    }

    clearState();
    return textResult({ status: "ended" });
  }

  async function connectMeet({
    activeServerUrl,
    roomId,
    token,
    role,
  }: {
    activeServerUrl: string;
    roomId: string;
    token: string;
    role: Sender;
  }): Promise<ToolResult> {
    const pendingMessages: string[] = [];
    const ws = webSocketFactory(wsUrl(activeServerUrl, roomId, token));

    meetState = createMeetState(
      roomId,
      token,
      role,
      ws as unknown as WebSocket,
      pendingMessages,
    );

    attachListeners(ws);

    try {
      await waitForOpen(ws);
    } catch {
      clearState();
      return errorResult("WebSocket connection failed");
    }

    await sleepFn(settleDelayMs);

    if (meetState) {
      meetState.collectingPending = null;
    }

    return textResult({
      roomId,
      status: "connected",
      pending: pendingMessages,
    });
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

  function attachListeners(ws: WebSocketLike): void {
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
        return;
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
}

function wsUrl(serverUrl: string, roomId: string, token: string): string {
  const base = serverUrl.replace(/^http/, "ws");
  return `${base}/rooms/${roomId}/ws?token=${token}`;
}

function waitForOpen(ws: WebSocketLike): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (event) => reject(event), { once: true });
  });
}

function parseParticipantLink(
  participantLink: string,
  expectedRole: Sender,
):
  | { inviteToken: string; baseUrl: string }
  | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(participantLink);
  } catch {
    return { error: "participantLink must be a valid AgentMeets invite link" };
  }

  const inviteMatch = parsed.pathname.match(/^\/j\/([A-Za-z0-9_.-]+)$/);
  if (!inviteMatch) {
    return { error: "participantLink must be a valid AgentMeets invite link" };
  }

  const suffix = inviteMatch[1].match(/\.(1|2)$/)?.[1];
  if (!suffix) {
    return { error: "participantLink must be a valid AgentMeets invite link" };
  }

  if (expectedRole === "host" && suffix !== "1") {
    return { error: roleInviteError("host") };
  }

  if (expectedRole === "guest" && suffix !== "2") {
    return { error: roleInviteError("guest") };
  }

  return {
    inviteToken: inviteMatch[1],
    baseUrl: parsed.origin,
  };
}

function roleInviteError(role: Sender): string {
  return `participantLink must be a ${role} AgentMeets invite link`;
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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
