import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createSmokeDir,
  startManagedProcess,
  waitForHttpReady,
} from "./lib/process";
import { parseServerMessage, waitForWsOpen } from "./lib/ws";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_PORT = 3100;
const UI_PORT = 3101;

interface RoomResponse {
  roomId: string;
  roomStem: string;
  hostAgentLink: string;
  guestAgentLink: string;
  inviteExpiresAt: string;
  status: string;
}

interface PublicRoomResponse {
  roomId: string;
  roomStem: string;
  status: string;
  hostAgentLink: string;
  guestAgentLink: string;
  inviteExpiresAt: string | null;
}

interface InviteManifestResponse {
  roomId: string;
  roomStem: string;
  role: "host" | "guest";
  status: string;
  openingMessage: string;
  expiresAt: string;
}

interface InviteClaimResponse {
  roomId: string;
  role: "host" | "guest";
  sessionToken: string;
  guestToken?: string;
  status: "activating";
}

type ServerEvent = Record<string, unknown>;

interface TrackedSocket {
  ws: WebSocket;
  nextEvent(timeoutMs?: number): Promise<ServerEvent>;
  close(): void;
}

async function main() {
  const smokeDir = await createSmokeDir("agentmeets-smoke");
  const databasePath = join(smokeDir, "agentmeets.db");
  const serverBaseUrl = `http://127.0.0.1:${SERVER_PORT}`;
  const uiBaseUrl = `http://127.0.0.1:${UI_PORT}`;

  const serverProcess = startManagedProcess(
    "server",
    ["bun", "run", "src/index.ts"],
    join(ROOT, "packages/server"),
    {
      PORT: String(SERVER_PORT),
      DATABASE_PATH: databasePath,
    },
  );

  try {
    await waitForHttpReady(`${serverBaseUrl}/health`, 10_000);

    const uiProcess = startManagedProcess(
      "ui",
      ["bun", "run", "dev", "--", "--port", String(UI_PORT)],
      join(ROOT, "packages/ui"),
      {
        AGENTMEETS_SERVER_URL: serverBaseUrl,
      },
    );

    try {
      await waitForHttpReady(`${uiBaseUrl}`, 20_000);
      await runSmokeScenarios({
        serverBaseUrl,
        uiBaseUrl,
        databasePath,
      });
    } finally {
      await uiProcess.stop();
    }
  } finally {
    await serverProcess.stop();
  }
}

async function runSmokeScenarios({
  serverBaseUrl,
  uiBaseUrl,
  databasePath,
}: {
  serverBaseUrl: string;
  uiBaseUrl: string;
  databasePath: string;
}) {
  const scenarios: Array<{
    name: string;
    run: () => Promise<void>;
  }> = [
    {
      name: "direct room creation returns roomId, roomStem, hostAgentLink, guestAgentLink",
      run: async () => {
        const room = await createRoom(serverBaseUrl, {
          openingMessage: "Direct room creation smoke.",
        });
        assert.equal(room.status, "waiting_for_join");
        assert.match(room.roomId, /^[A-Z0-9]{6}$/);
        assert.match(room.roomStem, /^r_[A-Za-z0-9_-]+$/);
        assert.match(room.hostAgentLink, /\.1$/);
        assert.match(room.guestAgentLink, /\.2$/);
      },
    },
    {
      name: "UI proxy POST /api/rooms returns the same paired-link contract",
      run: async () => {
        const room = await createRoom(`${uiBaseUrl}/api`, {
          openingMessage: "UI proxy room creation smoke.",
        });
        assert.equal(room.status, "waiting_for_join");
        assert.match(room.hostAgentLink, /\.1$/);
        assert.match(room.guestAgentLink, /\.2$/);
      },
    },
    {
      name: "public room payload returns waiting_for_join before any claim",
      run: async () => {
        const room = await createRoom(serverBaseUrl, {
          openingMessage: "Public room waiting state smoke.",
        });
        const publicRoom = await requestJson<PublicRoomResponse>(
          `${serverBaseUrl}/public/rooms/${room.roomStem}`,
        );
        assert.equal(publicRoom.status, "waiting_for_join");
        assert.equal(publicRoom.roomId, room.roomId);
        assert.equal(publicRoom.roomStem, room.roomStem);
      },
    },
    {
      name: "server invite manifest returns role, openingMessage, status, and expiresAt",
      run: async () => {
        const openingMessage = "Manifest smoke opening message.";
        const room = await createRoom(serverBaseUrl, { openingMessage });
        const manifest = await requestJson<InviteManifestResponse>(
          `${serverBaseUrl}/j/${extractInviteToken(room.guestAgentLink)}`,
        );
        assert.equal(manifest.role, "guest");
        assert.equal(manifest.openingMessage, openingMessage);
        assert.equal(manifest.status, "waiting_for_join");
        assert.ok(Date.parse(manifest.expiresAt) > Date.now());
      },
    },
    {
      name: "host and guest claim endpoints support idempotent replay with the same key",
      run: async () => {
        const room = await createRoom(serverBaseUrl, {
          openingMessage: "Idempotent claim smoke.",
        });
        const hostToken = extractInviteToken(room.hostAgentLink);
        const guestToken = extractInviteToken(room.guestAgentLink);

        const firstHostClaim = await claimInvite(serverBaseUrl, hostToken, "host-claim-key");
        const secondHostClaim = await claimInvite(serverBaseUrl, hostToken, "host-claim-key");
        const firstGuestClaim = await claimInvite(serverBaseUrl, guestToken, "guest-claim-key");
        const secondGuestClaim = await claimInvite(serverBaseUrl, guestToken, "guest-claim-key");

        assert.equal(firstHostClaim.sessionToken, secondHostClaim.sessionToken);
        assert.equal(firstGuestClaim.sessionToken, secondGuestClaim.sessionToken);
      },
    },
    {
      name: "host-first activation emits room_active on both sockets",
      run: async () => {
        const room = await createRoom(serverBaseUrl, {
          openingMessage: "Host first activation smoke.",
        });
        const hostClaim = await claimInvite(
          serverBaseUrl,
          extractInviteToken(room.hostAgentLink),
          "host-first-host",
        );
        const guestClaim = await claimInvite(
          serverBaseUrl,
          extractInviteToken(room.guestAgentLink),
          "host-first-guest",
        );

        const hostSocket = connectRoomSocket(serverBaseUrl, room.roomId, hostClaim.sessionToken);
        const guestSocket = connectRoomSocket(serverBaseUrl, room.roomId, guestClaim.sessionToken);

        try {
          await waitForWsOpen(hostSocket.ws);
          await waitForWsOpen(guestSocket.ws);

          const hostActivation = await hostSocket.nextEvent();
          const guestActivation = await guestSocket.nextEvent();

          assert.equal(hostActivation.type, "room_active");
          assert.equal(guestActivation.type, "room_active");
        } finally {
          hostSocket.close();
          guestSocket.close();
        }
      },
    },
    {
      name: "guest-first activation replays pre-join messages correctly",
      run: async () => {
        const room = await createRoom(serverBaseUrl, {
          openingMessage: "Opening context for guest-first replay.",
        });
        const hostClaim = await claimInvite(
          serverBaseUrl,
          extractInviteToken(room.hostAgentLink),
          "guest-first-host",
        );
        const guestClaim = await claimInvite(
          serverBaseUrl,
          extractInviteToken(room.guestAgentLink),
          "guest-first-guest",
        );

        const guestSocket = connectRoomSocket(serverBaseUrl, room.roomId, guestClaim.sessionToken);

        try {
          await waitForWsOpen(guestSocket.ws);
          sendClientMessage(guestSocket.ws, {
            clientMessageId: "guest-prejoin-1",
            replyToMessageId: null,
            content: "Guest context before host arrives.",
          });

          const guestAck = await guestSocket.nextEvent();
          assert.equal(guestAck.type, "ack");

          const hostSocket = connectRoomSocket(serverBaseUrl, room.roomId, hostClaim.sessionToken);

          try {
            await waitForWsOpen(hostSocket.ws);

            const hostActivation = await hostSocket.nextEvent();
            const hostReplay = await hostSocket.nextEvent();
            const guestActivation = await guestSocket.nextEvent();
            const guestReplay = await guestSocket.nextEvent();

            assert.equal(hostActivation.type, "room_active");
            assert.equal(hostReplay.type, "message");
            assert.equal(hostReplay.sender, "guest");
            assert.equal(hostReplay.content, "Guest context before host arrives.");

            assert.equal(guestActivation.type, "room_active");
            assert.equal(guestReplay.type, "message");
            assert.equal(guestReplay.sender, "host");
            assert.equal(guestReplay.content, "Opening context for guest-first replay.");
          } finally {
            hostSocket.close();
          }
        } finally {
          guestSocket.close();
        }
      },
    },
    {
      name: "message relay sends ack to sender and message to recipient",
      run: async () => {
        const room = await createRoom(serverBaseUrl, {
          openingMessage: "Relay smoke opening message.",
        });
        const { hostSocket, guestSocket } = await connectActiveRoom(serverBaseUrl, room);

        try {
          sendClientMessage(hostSocket.ws, {
            clientMessageId: "relay-host-1",
            replyToMessageId: null,
            content: "Relay smoke payload.",
          });

          const hostAck = await hostSocket.nextEvent();
          const guestMessage = await guestSocket.nextEvent();

          assert.equal(hostAck.type, "ack");
          assert.equal(hostAck.clientMessageId, "relay-host-1");
          assert.equal(guestMessage.type, "message");
          assert.equal(guestMessage.sender, "host");
          assert.equal(guestMessage.content, "Relay smoke payload.");
        } finally {
          hostSocket.close();
          guestSocket.close();
        }
      },
    },
    {
      name: "end flow returns ended to both sockets",
      run: async () => {
        const room = await createRoom(serverBaseUrl, {
          openingMessage: "End flow opening message.",
        });
        const { hostSocket, guestSocket } = await connectActiveRoom(serverBaseUrl, room);

        try {
          hostSocket.ws.send(JSON.stringify({ type: "end" }));

          const hostEnded = await hostSocket.nextEvent();
          const guestEnded = await guestSocket.nextEvent();

          assert.equal(hostEnded.type, "ended");
          assert.equal(hostEnded.reason, "user_ended");
          assert.equal(guestEnded.type, "ended");
          assert.equal(guestEnded.reason, "user_ended");
        } finally {
          hostSocket.close();
          guestSocket.close();
        }
      },
    },
    {
      name: "UI room page HTML contains both agent links and expiry copy",
      run: async () => {
        const room = await createRoom(`${uiBaseUrl}/api`, {
          openingMessage: "UI room page smoke.",
        });
        const response = await fetch(`${uiBaseUrl}/rooms/${room.roomStem}`);
        assert.equal(response.status, 200);

        const html = await response.text();
        assert.match(html, new RegExp(escapeRegExp(room.hostAgentLink)));
        assert.match(html, new RegExp(escapeRegExp(room.guestAgentLink)));
        assert.match(html, /Waiting rooms expire (at|after)/);
      },
    },
    {
      name: "legacy /rooms/:id/join still works for an unclaimed waiting room",
      run: async () => {
        const room = await createRoom(serverBaseUrl, {
          openingMessage: "Legacy join smoke.",
        });
        const response = await requestJson<{ guestToken: string }>(
          `${serverBaseUrl}/rooms/${room.roomId}/join`,
          {
            method: "POST",
          },
        );
        assert.ok(response.guestToken.length > 0);
      },
    },
    {
      name: "expired waiting room returns 410 from /public/rooms/:roomStem and /j/:token",
      run: async () => {
        const room = await createRoom(serverBaseUrl, {
          openingMessage: "Waiting expiry smoke.",
          inviteTtlSeconds: 1,
        });

        await Bun.sleep(1_100);

        const publicResponse = await fetch(`${serverBaseUrl}/public/rooms/${room.roomStem}`);
        const manifestResponse = await fetch(
          `${serverBaseUrl}/j/${extractInviteToken(room.guestAgentLink)}`,
        );

        assert.equal(publicResponse.status, 410);
        assert.deepEqual(await publicResponse.json(), { error: "room_expired" });
        assert.equal(manifestResponse.status, 410);
        assert.deepEqual(await manifestResponse.json(), { error: "invite_expired" });
      },
    },
    {
      name: "claimed room expires after disconnect plus idle timeout once the fix lands",
      run: async () => {
        const room = await createRoom(serverBaseUrl, {
          openingMessage: "Claim once, disconnect, then expire.",
        });
        const hostToken = extractInviteToken(room.hostAgentLink);
        const hostClaim = await claimInvite(
          serverBaseUrl,
          hostToken,
          "claimed-disconnect-expiry-host",
        );

        const hostSocket = connectRoomSocket(serverBaseUrl, room.roomId, hostClaim.sessionToken);
        await waitForWsOpen(hostSocket.ws);
        hostSocket.close();

        await Bun.sleep(100);

        const db = new Database(databasePath);
        try {
          db.prepare(`UPDATE rooms SET last_activity_at = ? WHERE id = ?`).run(
            new Date(Date.now() - 11 * 60 * 1000).toISOString(),
            room.roomId,
          );
        } finally {
          db.close();
        }

        const wsUpgradeResponse = await fetch(
          `${serverBaseUrl}/rooms/${room.roomId}/ws?token=${hostClaim.sessionToken}`,
        );
        assert.equal(wsUpgradeResponse.status, 410);

        const manifestResponse = await fetch(`${serverBaseUrl}/j/${hostToken}`);
        const publicResponse = await fetch(`${serverBaseUrl}/public/rooms/${room.roomStem}`);

        assert.equal(manifestResponse.status, 410);
        assert.deepEqual(await manifestResponse.json(), { error: "invite_expired" });
        assert.equal(publicResponse.status, 410);
        assert.deepEqual(await publicResponse.json(), { error: "room_expired" });

        const verifyDb = new Database(databasePath, { readonly: true });
        try {
          const row = verifyDb
            .prepare(`SELECT status, closed_at FROM rooms WHERE id = ?`)
            .get(room.roomId) as { status: string; closed_at: string | null };
          assert.equal(row.status, "expired");
          assert.ok(row.closed_at);
        } finally {
          verifyDb.close();
        }
      },
    },
  ];

  const completed: string[] = [];
  for (const scenario of scenarios) {
    await scenario.run();
    completed.push(scenario.name);
    console.log(`PASS ${scenario.name}`);
  }

  console.log(`Completed ${completed.length} smoke scenarios.`);
}

async function createRoom(
  baseUrl: string,
  input: {
    openingMessage: string;
    inviteTtlSeconds?: number;
  },
): Promise<RoomResponse> {
  return requestJson<RoomResponse>(`${baseUrl}/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  }, 201);
}

async function claimInvite(
  serverBaseUrl: string,
  inviteToken: string,
  idempotencyKey: string,
): Promise<InviteClaimResponse> {
  return requestJson<InviteClaimResponse>(
    `${serverBaseUrl}/invites/${inviteToken}/claim`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
      },
    },
    200,
  );
}

async function requestJson<T>(
  url: string,
  init?: RequestInit,
  expectedStatus = 200,
): Promise<T> {
  const response = await fetch(url, init);
  assert.equal(response.status, expectedStatus, `Unexpected status for ${url}`);
  return response.json() as Promise<T>;
}

function extractInviteToken(inviteUrl: string): string {
  const token = new URL(inviteUrl).pathname.split("/").pop();
  assert.ok(token, `Missing invite token in ${inviteUrl}`);
  return token;
}

function connectRoomSocket(
  serverBaseUrl: string,
  roomId: string,
  token: string,
) : TrackedSocket {
  const ws = new WebSocket(
    `${serverBaseUrl.replace(/^http/, "ws")}/rooms/${roomId}/ws?token=${token}`,
  );
  return createTrackedSocket(ws);
}

function createTrackedSocket(ws: WebSocket): TrackedSocket {
  const queuedEvents: ServerEvent[] = [];
  const waiters: Array<(event: ServerEvent) => void> = [];

  ws.addEventListener("message", (event) => {
    const parsed = parseServerMessage(String(event.data)) as ServerEvent;
    const next = waiters.shift();
    if (next) {
      next(parsed);
      return;
    }

    queuedEvents.push(parsed);
  });

  return {
    ws,
    async nextEvent(timeoutMs = 5_000) {
      if (queuedEvents.length > 0) {
        return queuedEvents.shift()!;
      }

      return new Promise<ServerEvent>((resolve, reject) => {
        let settled = false;
        const onClose = () => {
          cleanup();
          reject(new Error("Socket closed before the next event arrived"));
        };
        const onError = (event: Event) => {
          cleanup();
          reject(event);
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out waiting for server event"));
        }, timeoutMs);

        const waiter = (event: ServerEvent) => {
          cleanup();
          resolve(event);
        };

        waiters.push(waiter);
        ws.addEventListener("close", onClose, { once: true });
        ws.addEventListener("error", onError, { once: true });

        function cleanup() {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timeout);
          ws.removeEventListener("close", onClose);
          ws.removeEventListener("error", onError);
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) {
            waiters.splice(waiterIndex, 1);
          }
        }
      });
    },
    close() {
      ws.close();
    },
  };
}

function sendClientMessage(
  ws: WebSocket,
  payload: {
    clientMessageId: string;
    replyToMessageId: number | null;
    content: string;
  },
) {
  ws.send(
    JSON.stringify({
      type: "message",
      ...payload,
    }),
  );
}

async function connectActiveRoom(
  serverBaseUrl: string,
  room: RoomResponse,
): Promise<{ hostSocket: TrackedSocket; guestSocket: TrackedSocket }> {
  const hostClaim = await claimInvite(
    serverBaseUrl,
    extractInviteToken(room.hostAgentLink),
    `${room.roomId}-host-active`,
  );
  const guestClaim = await claimInvite(
    serverBaseUrl,
    extractInviteToken(room.guestAgentLink),
    `${room.roomId}-guest-active`,
  );

  const hostSocket = connectRoomSocket(serverBaseUrl, room.roomId, hostClaim.sessionToken);
  const guestSocket = connectRoomSocket(serverBaseUrl, room.roomId, guestClaim.sessionToken);

  await waitForWsOpen(hostSocket.ws);
  await waitForWsOpen(guestSocket.ws);

  const hostActivation = await hostSocket.nextEvent();
  const guestActivation = await guestSocket.nextEvent();
  assert.equal(hostActivation.type, "room_active");
  assert.equal(guestActivation.type, "room_active");

  const guestOpeningReplay = await guestSocket.nextEvent();
  assert.equal(guestOpeningReplay.type, "message");
  assert.equal(guestOpeningReplay.sender, "host");

  return { hostSocket, guestSocket };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

await main();
