import { createEndPayload, createMeetState, createMessagePayload, processServerMessage } from "./client.js";
import type { PendingReplyResult, MeetState } from "./client.js";
import { createCreateMeetHandler } from "./tools/create-meet.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type Sender = "host" | "guest";

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
  sendAndWait(input: { message: string; timeout?: number }): Promise<ToolResult>;
  confirmSend(input: { draftId?: string; timeout?: number }): Promise<ToolResult>;
  reviseDraft(input: { draftId: string; revisedMessage: string }): Promise<ToolResult>;
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
    sendAndWait,
    confirmSend,
    reviseDraft,
    endMeet,
    getMeetState: () => meetState,
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

  async function sendAndWait(input: { message: string; timeout?: number }): Promise<ToolResult> {
    if (!meetState) {
      return errorResult(
        "No active meet. Call create_meet, host_meet, guest_meet, or join_meet first.",
      );
    }

    if (!meetState.ws || meetState.ws.readyState !== 1) {
      clearState();
      return errorResult("Connection lost");
    }

    const activeMeet = meetState;
    const timeout = input.timeout ?? 300;
    const payload = createMessagePayload(activeMeet, input.message);

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
      const otherRole = activeMeet.role === "host" ? "guest" : "host";
      return textResult({
        from: otherRole,
        reply: result.content,
        status: "ok",
        nextAction: "Call send_and_wait again with your response to continue the conversation. Do not ask the user what to say.",
      });
    }

    const reason =
      result.reason ?? (meetState === null ? "disconnected" : "timeout");
    clearState();
    return textResult({
      reply: null,
      status: "ended",
      reason,
      nextAction: "The conversation has ended. Present your human user with a summary including: 1) Key conclusions or decisions reached, 2) Action items for either party, if any.",
    });
  }

  async function confirmSend(input: { draftId?: string; timeout?: number }): Promise<ToolResult> {
    const activeMeet = meetState;
    if (!activeMeet) {
      return errorResult("No active meet session");
    }

    const ws = activeMeet.ws;
    if (!ws || ws.readyState !== 1) {
      clearState();
      return errorResult("WebSocket not connected");
    }

    const timeout = input.timeout ?? 300;

    // Listen-only mode: no draftId means just wait for inbound message
    const listenOnly = !input.draftId;

    if (!listenOnly) {
      if (!activeMeet.stagedDraft) {
        return errorResult("No staged draft to send");
      }

      if (activeMeet.stagedDraft.id !== input.draftId) {
        return errorResult("Draft ID mismatch — the draft may have been replaced");
      }
    }

    // Extract and clear draft before sending (if not listen-only)
    let message: string | null = null;
    if (!listenOnly && activeMeet.stagedDraft) {
      message = activeMeet.stagedDraft.message;
      activeMeet.stagedDraft = null;
    }

    const result = await new Promise<PendingReplyResult>((resolve) => {
      const finish = (r: PendingReplyResult) => {
        clearTimeout(timer);
        activeMeet.pendingReply = null;
        resolve(r);
      };

      activeMeet.pendingReply = { resolve: finish };

      const timer = setTimeout(
        () => finish({ content: null, reason: "timeout" }),
        timeout * 1000,
      );

      if (message !== null) {
        const payload = createMessagePayload(activeMeet, message);
        try {
          ws.send(JSON.stringify(payload));
        } catch {
          finish({ content: null, reason: "disconnected" });
        }
      }
    });

    if (result.error) {
      return errorResult(
        `Protocol error (${result.error.code}): ${result.error.message}`,
      );
    }

    if (result.content !== null) {
      return textResult({ reply: result.content, status: "ok", queuedMessages: [] });
    }

    const reason = result.reason ?? "unknown";
    if (reason === "timeout" || reason === "disconnected") {
      clearState();
    }
    return textResult({ reply: null, status: "ended", reason });
  }

  async function reviseDraft(input: { draftId: string; revisedMessage: string }): Promise<ToolResult> {
    const activeMeet = meetState;
    if (!activeMeet) {
      return errorResult("No active meet session");
    }

    if (!activeMeet.stagedDraft) {
      return errorResult("No staged draft to revise");
    }

    if (activeMeet.stagedDraft.id !== input.draftId) {
      return errorResult("Draft ID mismatch — the draft may have been replaced");
    }

    activeMeet.stagedDraft.message = input.revisedMessage;

    return textResult({
      status: "staged",
      draftId: activeMeet.stagedDraft.id,
      message: input.revisedMessage,
      originalDraft: activeMeet.stagedDraft.originalDraft,
    });
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
    return textResult({
      status: "ended",
      nextAction: "The conversation has ended. Present your human user with a summary including: 1) Key conclusions or decisions reached, 2) Action items for either party, if any.",
    });
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

    const result: Record<string, unknown> = {
      roomId,
      role,
      status: "connected",
      pending: pendingMessages,
    };

    if (pendingMessages.length > 0) {
      result.nextAction = "Call send_and_wait now with your response to the pending message(s). Do not ask the user what to say.";
    } else {
      result.nextAction = "Call send_and_wait now to start the conversation. Do not ask the user what to say.";
    }

    return textResult(result);
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
