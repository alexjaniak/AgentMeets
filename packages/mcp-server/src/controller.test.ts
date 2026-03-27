import { describe, expect, test } from "bun:test";

function parseToolResult(result: {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  #listeners = new Map<
    string,
    Array<{ listener: (event: any) => void; once: boolean }>
  >();

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.#dispatch("open", { type: "open" });
    });
  }

  addEventListener(
    type: string,
    listener: (event: any) => void,
    options?: { once?: boolean },
  ): void {
    const entries = this.#listeners.get(type) ?? [];
    entries.push({ listener, once: options?.once ?? false });
    this.#listeners.set(type, entries);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.#dispatch("close", { type: "close", code, reason });
  }

  emitMessage(data: object): void {
    this.#dispatch("message", { type: "message", data: JSON.stringify(data) });
  }

  emitError(error: unknown): void {
    this.#dispatch("error", { type: "error", error });
  }

  #dispatch(type: string, event: any): void {
    const listeners = this.#listeners.get(type) ?? [];
    const retained: Array<{ listener: (event: any) => void; once: boolean }> = [];

    for (const entry of listeners) {
      entry.listener(event);
      if (!entry.once) {
        retained.push(entry);
      }
    }

    this.#listeners.set(type, retained);
  }
}

describe("meet controller invite-link flows", () => {
  test("host_meet claims the participant link and restores send_and_wait/end_meet", async () => {
    const module = await import("./controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const sockets: FakeWebSocket[] = [];
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

    const controller = module.createMeetController({
      serverUrl: "https://agentmeets.test",
      fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://agentmeets.test/rooms") {
          return new Response(
            JSON.stringify({
              roomId: "ROOM01",
              roomStem: "r_9wK3mQvH8",
              hostAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.1",
              guestAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.2",
              inviteExpiresAt: "2026-03-25T18:12:00.000Z",
              status: "waiting_for_join",
            }),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          );
        }

        if (url === "https://agentmeets.test/invites/r_9wK3mQvH8.1/claim") {
          return new Response(
            JSON.stringify({
              roomId: "ROOM01",
              role: "host",
              sessionToken: "host-session-token",
              status: "activating",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
      webSocketFactory(url: string) {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
      settleDelayMs: 0,
    });

    const created = parseToolResult(
      await controller.createMeet({
        openingMessage: "Let's debug the release pipeline.",
      }),
    ) as {
      roomId: string;
      yourAgentLink: string;
    };

    expect(
      parseToolResult(
        await controller.hostMeet({
          participantLink: created.yourAgentLink,
        }),
      ),
    ).toEqual({
      roomId: "ROOM01",
      status: "connected",
      pending: [],
    });

    expect(fetchCalls[1]).toMatchObject({
      url: "https://agentmeets.test/invites/r_9wK3mQvH8.1/claim",
      init: {
        method: "POST",
        headers: {
          "Idempotency-Key": "agentmeets-host:r_9wK3mQvH8.1",
        },
      },
    });

    const hostSocket = sockets[0]!;
    hostSocket.emitMessage({ type: "room_active" });

    const replyPromise = controller.sendAndWait({
      message: "What changed?",
      timeout: 1,
    });

    const outboundMessage = JSON.parse(hostSocket.sent[0]!) as {
      type: string;
      clientMessageId: string;
      replyToMessageId: number | null;
      content: string;
    };
    expect(outboundMessage).toMatchObject({
      type: "message",
      replyToMessageId: null,
      content: "What changed?",
    });

    hostSocket.emitMessage({
      type: "ack",
      messageId: 1,
      clientMessageId: outboundMessage.clientMessageId,
      replyToMessageId: null,
      createdAt: "2026-03-25T18:12:01.000Z",
    });
    hostSocket.emitMessage({
      type: "message",
      messageId: 2,
      sender: "guest",
      clientMessageId: "guest-reply-1",
      replyToMessageId: 1,
      content: "The invite claim worked.",
      createdAt: "2026-03-25T18:12:02.000Z",
    });

    expect(parseToolResult(await replyPromise)).toEqual({
      reply: "The invite claim worked.",
      status: "ok",
    });

    expect(parseToolResult(await controller.endMeet())).toEqual({
      status: "ended",
    });
    expect(JSON.parse(hostSocket.sent[1]!)).toEqual({ type: "end" });
  });

  test("host_meet rejects guest invite links before claiming them", async () => {
    const module = await import("./controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const fetchCalls: string[] = [];

    const controller = module.createMeetController({
      serverUrl: "https://agentmeets.test",
      fetchFn: async (input: RequestInfo | URL) => {
        const url = String(input);
        fetchCalls.push(url);

        return new Response(
          JSON.stringify({
            roomId: "ROOM01",
            roomStem: "r_9wK3mQvH8",
            hostAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.1",
            guestAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.2",
            inviteExpiresAt: "2026-03-25T18:12:00.000Z",
            status: "waiting_for_join",
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      },
      webSocketFactory(url: string) {
        return new FakeWebSocket(url) as unknown as WebSocket;
      },
      settleDelayMs: 0,
    });

    const created = parseToolResult(
      await controller.createMeet({
        openingMessage: "Opening context",
      }),
    ) as {
      otherAgentLink: string;
    };

    const result = await controller.hostMeet({
      participantLink: created.otherAgentLink,
    });

    expect(result.isError).toBe(true);
    expect(parseToolResult(result)).toEqual({
      error: "participantLink must be a host AgentMeets invite link",
    });
    expect(fetchCalls).toEqual(["https://agentmeets.test/rooms"]);
  });

  test("guest_meet claims a guest participant link and connects deterministically", async () => {
    const module = await import("./controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const sockets: FakeWebSocket[] = [];
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

    const controller = module.createMeetController({
      serverUrl: "https://agentmeets.test",
      fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });

        if (url === "https://agentmeets.test/rooms") {
          return new Response(
            JSON.stringify({
              roomId: "ROOM01",
              roomStem: "r_9wK3mQvH8",
              hostAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.1",
              guestAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.2",
              inviteExpiresAt: "2026-03-25T18:12:00.000Z",
              status: "waiting_for_join",
            }),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          );
        }

        if (url === "https://agentmeets.test/invites/r_9wK3mQvH8.2/claim") {
          return new Response(
            JSON.stringify({
              roomId: "ROOM01",
              role: "guest",
              sessionToken: "guest-session-token",
              status: "activating",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
      webSocketFactory(url: string) {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
      settleDelayMs: 0,
    });

    const created = parseToolResult(
      await controller.createMeet({
        openingMessage: "Guest should join with the direct link.",
      }),
    ) as {
      otherAgentLink: string;
    };

    expect(
      parseToolResult(
        await controller.guestMeet({
          participantLink: created.otherAgentLink,
        }),
      ),
    ).toEqual({
      roomId: "ROOM01",
      status: "connected",
      pending: [],
    });

    expect(fetchCalls[1]).toMatchObject({
      url: "https://agentmeets.test/invites/r_9wK3mQvH8.2/claim",
      init: {
        method: "POST",
        headers: {
          "Idempotency-Key": "agentmeets-guest:r_9wK3mQvH8.2",
        },
      },
    });
    expect(sockets[0]?.url).toBe(
      "wss://agentmeets.test/rooms/ROOM01/ws?token=guest-session-token",
    );
  });

  test("guest_meet rejects host invite links locally", async () => {
    const module = await import("./controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const fetchCalls: string[] = [];

    const controller = module.createMeetController({
      serverUrl: "https://agentmeets.test",
      fetchFn: async (input: RequestInfo | URL) => {
        const url = String(input);
        fetchCalls.push(url);
        return new Response("unexpected", { status: 500 });
      },
      webSocketFactory(url: string) {
        return new FakeWebSocket(url) as unknown as WebSocket;
      },
      settleDelayMs: 0,
    });

    const result = await controller.guestMeet({
      participantLink: "https://agentmeets.test/j/r_9wK3mQvH8.1",
    });

    expect(result.isError).toBe(true);
    expect(parseToolResult(result)).toEqual({
      error: "participantLink must be a guest AgentMeets invite link",
    });
    expect(fetchCalls).toEqual([]);
  });

  test("guest_meet rejects malformed invite links locally", async () => {
    const module = await import("./controller.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const fetchCalls: string[] = [];

    const controller = module.createMeetController({
      serverUrl: "https://agentmeets.test",
      fetchFn: async (input: RequestInfo | URL) => {
        const url = String(input);
        fetchCalls.push(url);
        return new Response("unexpected", { status: 500 });
      },
      webSocketFactory(url: string) {
        return new FakeWebSocket(url) as unknown as WebSocket;
      },
      settleDelayMs: 0,
    });

    const result = await controller.guestMeet({
      participantLink: "not-an-invite-link",
    });

    expect(result.isError).toBe(true);
    expect(parseToolResult(result)).toEqual({
      error: "participantLink must be a valid AgentMeets invite link",
    });
    expect(fetchCalls).toEqual([]);
  });
});
