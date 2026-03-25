# AgentMeets Room UI Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated `agentmeets` UI that creates ephemeral rooms with a required starting message, returns two related participant links, mirrors the `innies` visual style, and destroys rooms after 10 minutes of inactivity.

**Architecture:** Build on top of the zero-setup invite flow branch, not the older room-code-only `main`. Refactor the server room core from “single guest invite + raw host token” to “paired role-scoped participant links,” then adapt the MCP/helper bootstrap to that contract, then add a separate Next.js `packages/ui` app that proxies to the server and renders create/result/expired browser screens. Keep the server as the source of truth for room creation, expiry, and presentation metadata; the browser remains a creation-and-instructions surface only.

**Tech Stack:** TypeScript, Bun, Hono, SQLite, Next.js 15 app router, React 18, MCP, Node.js CLI runtime for `packages/session-helper`

---

## Preconditions

- This plan assumes implementation starts from the integrated zero-setup invite-flow branch or its merged equivalent.
- Current canonical base while writing this plan: `zero-setup-agent-chat-chunk3` in `/Users/dylanvu/.config/superpowers/worktrees/AgentMeets/zero-setup-agent-chat-chunk3`
- Do **not** implement this plan from the older `main` branch unless the zero-setup invite-flow PR has already been merged there.
- Leave unrelated lockfile churn alone until the task that intentionally adds `packages/ui` dependencies.

## File Structure

### Existing files to modify

- `README.md`
- `packages/shared/src/types.ts`
- `packages/shared/src/index.ts`
- `packages/server/src/db/index.ts`
- `packages/server/src/db/invites.ts`
- `packages/server/src/db/messages.ts`
- `packages/server/src/db/rooms.ts`
- `packages/server/src/db/schema.ts`
- `packages/server/src/index.ts`
- `packages/server/src/routes/invites.ts`
- `packages/server/src/routes/rooms.ts`
- `packages/server/src/routes/rooms.test.ts`
- `packages/server/src/ws/handler.ts`
- `packages/server/src/ws/room-manager.ts`
- `packages/server/src/ws/upgrade.ts`
- `packages/server/tests/e2e/flow.test.ts`
- `packages/server/tests/e2e/invite-flow.test.ts`
- `packages/server/tests/ws.test.ts`
- `packages/mcp-server/src/tools/create-meet.ts`
- `packages/mcp-server/src/index.test.ts`
- `packages/session-helper/package.json`
- `packages/session-helper/src/cli.ts`

### New files to create

- `packages/server/src/routes/public-rooms.ts`
- `packages/server/src/routes/public-rooms.test.ts`
- `packages/server/tests/e2e/browser-room.test.ts`
- `packages/session-helper/src/cli.test.ts`
- `packages/ui/package.json`
- `packages/ui/tsconfig.json`
- `packages/ui/next.config.mjs`
- `packages/ui/src/app/layout.tsx`
- `packages/ui/src/app/globals.css`
- `packages/ui/src/app/page.tsx`
- `packages/ui/src/app/page.module.css`
- `packages/ui/src/app/rooms/[roomStem]/page.tsx`
- `packages/ui/src/app/rooms/[roomStem]/page.module.css`
- `packages/ui/src/app/api/rooms/route.ts`
- `packages/ui/src/app/api/rooms/[roomStem]/route.ts`
- `packages/ui/src/components/CreateRoomForm.tsx`
- `packages/ui/src/components/CreateRoomForm.test.tsx`
- `packages/ui/src/components/RoomResult.tsx`
- `packages/ui/src/components/RoomResult.test.tsx`
- `packages/ui/src/components/ExpiredRoomState.tsx`
- `packages/ui/src/components/ExpiredRoomState.test.tsx`
- `packages/ui/src/lib/api.ts`
- `packages/ui/src/lib/api.test.ts`
- `packages/ui/src/lib/present.ts`
- `packages/ui/src/lib/present.test.ts`

### Boundary notes

- Keep server-side browser-safe room metadata in a dedicated route module instead of overloading the invite manifest route.
- Keep the browser UI as a separate `packages/ui` Next.js app. Do not bolt HTML pages onto the Hono server.
- Keep UI route handlers as thin proxies to the server so the browser does not need direct cross-origin access.
- Do not try to finish a broader deployment story in this plan. Deliver a buildable UI package and local run instructions; separate deployment wiring can follow if needed.
- Do not build a browser chat interface. The browser creates rooms and shows instructions only.

## Chunk 1: Room Core For Paired Participant Links

### Task 1: Add room stem and role-scoped invite persistence

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/db/index.ts`
- Modify: `packages/server/src/db/rooms.ts`
- Modify: `packages/server/src/db/invites.ts`
- Modify: `packages/server/src/db/messages.ts`
- Modify: `packages/server/src/db/db.test.ts`
- Test: `packages/server/src/db/db.test.ts`

- [ ] **Step 1: Write the failing DB tests for room stem and role-scoped invites**

```ts
test("createRoom persists a high-entropy room stem and opening message id", () => {
  const room = createRoom(db, "ROOM01", "r_9wK3mQvH8", "host-token", "Start here");

  expect(room.room_stem).toBe("r_9wK3mQvH8");
  expect(room.opening_message_id).toEqual(expect.any(Number));
  expect(room.last_activity_at).toEqual(expect.any(String));
});

test("issueParticipantInvites creates one host invite and one guest invite for the same room", () => {
  issueParticipantInvite(db, "ROOM01", "host", "r_9wK3mQvH8.1");
  issueParticipantInvite(db, "ROOM01", "guest", "r_9wK3mQvH8.2");

  expect(listParticipantInvites(db, "ROOM01")).toEqual([
    expect.objectContaining({ participant_role: "host" }),
    expect.objectContaining({ participant_role: "guest" }),
  ]);
});

test("claimParticipantInvite assigns the correct session token field by role", () => {
  const hostClaim = claimInvite(db, "r_9wK3mQvH8.1", "host-claim");
  const guestClaim = claimInvite(db, "r_9wK3mQvH8.2", "guest-claim");

  expect(hostClaim.role).toBe("host");
  expect(guestClaim.role).toBe("guest");
  expect(getRoom(db, "ROOM01")).toMatchObject({
    host_token: hostClaim.sessionToken,
    guest_token: guestClaim.sessionToken,
  });
});
```

- [ ] **Step 2: Run the DB tests to verify they fail**

Run: `cd packages/server && bun test src/db/db.test.ts`

Expected: FAIL because the schema and DB helpers only support one invite, no `room_stem`, and no role-scoped claim path.

- [ ] **Step 3: Implement the schema and DB helper changes**

```sql
ALTER TABLE rooms ADD COLUMN room_stem TEXT;
ALTER TABLE rooms ADD COLUMN last_activity_at TEXT NOT NULL DEFAULT (datetime('now'));

CREATE TABLE IF NOT EXISTS invites (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id               TEXT NOT NULL REFERENCES rooms(id),
  participant_role      TEXT NOT NULL,
  token_hash            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  claimed_at            TEXT,
  claim_idempotency_key TEXT,
  claim_session_token   TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_room_role ON invites(room_id, participant_role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_room_stem ON rooms(room_stem);
```

```ts
export function createRoom(
  db: Database,
  roomId: string,
  roomStem: string,
  openingMessage: string,
) {
  // Persist the room row, opening message, opening_message_id, and last_activity_at
}

export function issueParticipantInvite(
  db: Database,
  roomId: string,
  role: "host" | "guest",
  inviteToken: string,
  expiresAt: string,
) {
  // Store one invite row per role
}
```

- [ ] **Step 4: Re-run the DB tests**

Run: `cd packages/server && bun test src/db/db.test.ts`

Expected: PASS with persisted `room_stem`, `last_activity_at`, two role-scoped invites, and role-correct session-token assignment on claim.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src packages/server/src/db packages/server/src/db/db.test.ts
git commit -m "feat: add paired participant invite persistence"
```

### Task 2: Replace single-invite create flow with paired participant-link APIs

**Files:**
- Modify: `packages/server/src/routes/rooms.ts`
- Modify: `packages/server/src/routes/invites.ts`
- Modify: `packages/server/src/index.ts`
- Create: `packages/server/src/routes/public-rooms.ts`
- Modify: `packages/server/src/routes/rooms.test.ts`
- Create: `packages/server/src/routes/public-rooms.test.ts`
- Modify: `packages/server/src/routes/invites.test.ts`
- Modify: `packages/server/tests/e2e/invite-flow.test.ts`
- Test: `packages/server/src/routes/rooms.test.ts`
- Test: `packages/server/src/routes/public-rooms.test.ts`
- Test: `packages/server/src/routes/invites.test.ts`
- Test: `packages/server/tests/e2e/invite-flow.test.ts`

- [ ] **Step 1: Write the failing route tests for paired links and browser-safe room presentation**

```ts
test("POST /rooms returns host and guest participant links from the same room stem", async () => {
  expect(body).toEqual({
    roomId: expect.any(String),
    roomStem: expect.stringMatching(/^r_[A-Za-z0-9_-]+$/),
    hostAgentLink: expect.stringMatching(/\.1$/),
    guestAgentLink: expect.stringMatching(/\.2$/),
    inviteExpiresAt: expect.any(String),
    status: "waiting_for_join",
  });
});

test("GET /public/rooms/:roomStem returns browser-safe room instructions while active", async () => {
  expect(body).toEqual({
    roomId: "ROOM01",
    roomStem: "r_9wK3mQvH8",
    status: "waiting_for_join",
    hostAgentLink: expect.stringMatching(/\.1$/),
    guestAgentLink: expect.stringMatching(/\.2$/),
    inviteExpiresAt: expect.any(String),
  });
});

test("GET /j/:inviteToken returns the invite role in the manifest", async () => {
  expect(body).toEqual({
    roomId: "ROOM01",
    roomStem: "r_9wK3mQvH8",
    role: "host",
    status: "waiting_for_join",
    openingMessage: "Start here",
    expiresAt: expect.any(String),
  });
});

test("POST /invites/:inviteToken/claim returns a role-neutral session token payload", async () => {
  expect(body).toEqual({
    roomId: "ROOM01",
    role: "guest",
    sessionToken: expect.any(String),
    status: "activating",
  });
});
```

- [ ] **Step 2: Run the focused route tests to verify they fail**

Run: `cd packages/server && bun test src/routes/rooms.test.ts src/routes/public-rooms.test.ts src/routes/invites.test.ts tests/e2e/invite-flow.test.ts`

Expected: FAIL because the server still returns one `inviteUrl`, has no browser-safe room presentation endpoint, and claim results are still guest-specific.

- [ ] **Step 3: Implement the paired-link room and public-room routes**

```ts
router.post("/rooms", async (c) => {
  const roomStem = generateRoomStem();
  const hostInviteToken = `${roomStem}.1`;
  const guestInviteToken = `${roomStem}.2`;

  createRoomWithParticipantInvites({
    roomId,
    roomStem,
    openingMessage,
    hostInviteToken,
    guestInviteToken,
    inviteExpiresAt,
  });

  return c.json({
    roomId,
    roomStem,
    hostAgentLink: absoluteInviteUrl(c.req.url, hostInviteToken),
    guestAgentLink: absoluteInviteUrl(c.req.url, guestInviteToken),
    inviteExpiresAt,
    status: "waiting_for_join",
  }, 201);
});
```

```ts
router.get("/public/rooms/:roomStem", (c) => {
  const room = getPresentableRoomByStem(db, c.req.param("roomStem"));
  if (!room) return c.json({ error: "room_not_found" }, 404);
  if (room.status === "expired" || room.status === "ended") {
    return c.json({ error: "room_expired" }, 410);
  }

  return c.json(room, 200);
});
```

```ts
return c.json({
  roomId: manifest.roomId,
  roomStem: manifest.roomStem,
  role: manifest.role,
  status: manifest.status,
  openingMessage: manifest.openingMessage,
  expiresAt: manifest.expiresAt,
});
```

- [ ] **Step 4: Re-run the focused route tests**

Run: `cd packages/server && bun test src/routes/rooms.test.ts src/routes/public-rooms.test.ts src/routes/invites.test.ts tests/e2e/invite-flow.test.ts`

Expected: PASS with paired participant links, manifest role metadata, role-neutral claim results, and browser-safe room presentation payloads.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes packages/server/src/index.ts packages/server/tests/e2e/invite-flow.test.ts
git commit -m "feat: add paired participant room APIs"
```

### Task 3: Enforce 10-minute expiry and remove absolute hard-timeout behavior

**Files:**
- Modify: `packages/server/src/db/rooms.ts`
- Modify: `packages/server/src/db/messages.ts`
- Modify: `packages/server/src/ws/room-manager.ts`
- Modify: `packages/server/src/ws/upgrade.ts`
- Modify: `packages/server/tests/ws.test.ts`
- Modify: `packages/server/tests/e2e/flow.test.ts`
- Create: `packages/server/tests/e2e/browser-room.test.ts`
- Modify: `packages/server/src/routes/public-rooms.test.ts`
- Test: `packages/server/tests/ws.test.ts`
- Test: `packages/server/tests/e2e/flow.test.ts`
- Test: `packages/server/tests/e2e/browser-room.test.ts`

- [ ] **Step 1: Write the failing lifecycle tests for idle expiry and expired browser presentation**

```ts
test("active rooms emit ended: expired after 10 minutes without accepted messages", async () => {
  expect(await waitForMessage(hostWs)).toEqual({ type: "ended", reason: "expired" });
  expect(await waitForMessage(guestWs)).toEqual({ type: "ended", reason: "expired" });
});

test("GET /public/rooms/:roomStem returns 410 after idle expiry", async () => {
  expect(response.status).toBe(410);
  expect(await response.json()).toEqual({ error: "room_expired" });
});

test("room activity updates last_activity_at when a message is accepted", async () => {
  expect(refreshed.last_activity_at).not.toBe(original.last_activity_at);
});
```

- [ ] **Step 2: Run the lifecycle tests to verify they fail**

Run: `cd packages/server && bun test tests/ws.test.ts tests/e2e/flow.test.ts tests/e2e/browser-room.test.ts`

Expected: FAIL because the room manager still carries a 30-minute hard timeout and idle expiration is not fully represented as room expiry in browser-safe routes.

- [ ] **Step 3: Implement 10-minute invite/idle expiry as the only lifetime rule**

```ts
const DEFAULT_INVITE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// Remove the old hard timeout entirely.
// On accepted message persistence, update rooms.last_activity_at.
// On idle timeout, call expireRoom(...), emit ended: expired, and reject future public/manifest loads with 410.
```

- [ ] **Step 4: Re-run the lifecycle tests**

Run: `cd packages/server && bun test tests/ws.test.ts tests/e2e/flow.test.ts tests/e2e/browser-room.test.ts`

Expected: PASS with `ended.reason = "expired"`, updated `last_activity_at`, and `410 room_expired` for browser-safe room loads after expiry.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db packages/server/src/ws packages/server/tests
git commit -m "fix: enforce 10 minute room expiry semantics"
```

## Chunk 2: CLI-Agent Flow On Top Of The Paired-Link Contract

### Task 4: Update session-helper bootstrap to use role links instead of raw host tokens

**Files:**
- Modify: `packages/session-helper/package.json`
- Modify: `packages/session-helper/src/cli.ts`
- Create: `packages/session-helper/src/cli.test.ts`
- Test: `packages/session-helper/src/cli.test.ts`

- [ ] **Step 1: Write the failing CLI tests for participant-link bootstrap**

```ts
test("host mode requires --participant-link instead of --host-token", async () => {
  const exitCode = await main(["host", "--participant-link", "https://agentmeets.test/j/r_9wK3mQvH8.1"]);
  expect(exitCode).toBe(0);
});

test("help output documents host bootstrap from the role-scoped link", async () => {
  expect(helpText).toContain("agentmeets-session host --participant-link <url>");
});
```

- [ ] **Step 2: Run the session-helper CLI tests to verify they fail**

Run: `bun test packages/session-helper/src/cli.test.ts`

Expected: FAIL because `cli.ts` still expects `--room-id`, `--host-token`, and `--invite-link`.

- [ ] **Step 3: Implement the minimal CLI contract change**

```ts
const HELP_TEXT = `agentmeets-session

Usage:
  agentmeets-session host --participant-link <url> [--adapter claude-code|codex]
`;

if (!participantLink) {
  process.stderr.write("Missing required host argument: --participant-link\n");
  return 1;
}

await adapter.injectHostReadyPrompt({
  participantLink,
});
```

- [ ] **Step 4: Re-run the session-helper CLI tests**

Run: `bun test packages/session-helper/src/cli.test.ts`

Expected: PASS with the simplified role-link bootstrap contract.

- [ ] **Step 5: Commit**

```bash
git add packages/session-helper/package.json packages/session-helper/src/cli.ts packages/session-helper/src/cli.test.ts
git commit -m "refactor: bootstrap host helper from participant link"
```

### Task 5: Update MCP create_meet to return the browser-compatible paired-link output

**Files:**
- Modify: `packages/mcp-server/src/tools/create-meet.ts`
- Modify: `packages/mcp-server/src/index.test.ts`
- Test: `packages/mcp-server/src/index.test.ts`

- [ ] **Step 1: Write the failing MCP tests for paired-link creation output**

```ts
test("create_meet returns host and guest links from the unified room contract", async () => {
  expect(parseToolResult(result)).toEqual({
    roomId: "ROOM01",
    yourAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.1",
    otherAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.2",
    shareText: "Tell the other agent to join this chat: https://agentmeets.test/j/r_9wK3mQvH8.2",
    hostHelperCommand:
      "AGENTMEETS_URL='https://agentmeets.test' npx -y @mp-labs/agentmeets-session host --participant-link 'https://agentmeets.test/j/r_9wK3mQvH8.1'",
    status: "waiting_for_join",
  });
});
```

- [ ] **Step 2: Run the MCP tests to verify they fail**

Run: `bun test packages/mcp-server/src/index.test.ts`

Expected: FAIL because the tool still expects `{ hostToken, inviteUrl }` from the server and builds `hostHelperCommand` from raw token arguments.

- [ ] **Step 3: Implement the MCP create_meet contract update**

```ts
interface CreateRoomResponse {
  roomId: string;
  roomStem: string;
  hostAgentLink: string;
  guestAgentLink: string;
  inviteExpiresAt: string;
  status: "waiting_for_join";
}

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
```

- [ ] **Step 4: Re-run the MCP tests**

Run: `bun test packages/mcp-server/src/index.test.ts`

Expected: PASS with paired-link output and link-based host bootstrap.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/create-meet.ts packages/mcp-server/src/index.test.ts
git commit -m "feat: align mcp create_meet with paired room links"
```

## Chunk 3: New Next.js UI Package

### Task 6: Scaffold the new UI package and shared presentation helpers

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/next.config.mjs`
- Create: `packages/ui/src/app/layout.tsx`
- Create: `packages/ui/src/app/globals.css`
- Create: `packages/ui/src/app/page.tsx`
- Create: `packages/ui/src/app/page.module.css`
- Create: `packages/ui/src/lib/api.ts`
- Create: `packages/ui/src/lib/api.test.ts`
- Create: `packages/ui/src/lib/present.ts`
- Create: `packages/ui/src/lib/present.test.ts`
- Test: `packages/ui/src/lib/api.test.ts`
- Test: `packages/ui/src/lib/present.test.ts`

- [ ] **Step 1: Write the failing UI helper tests for room presentation and API payload normalization**

```ts
test("presentRoomLinks labels the two related participant links for browser UX", () => {
  expect(
    presentRoomLinks({
      hostAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.1",
      guestAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.2",
    }),
  ).toEqual({
    yourAgentInstruction:
      "Tell your agent to join this chat: https://agentmeets.test/j/r_9wK3mQvH8.1",
    otherAgentInstruction:
      "Tell the other agent to join this chat: https://agentmeets.test/j/r_9wK3mQvH8.2",
  });
});

test("normalizePublicRoomResponse maps expired 410 responses to an expired state", async () => {
  expect(await readPublicRoomResponse(response410)).toEqual({
    kind: "expired",
  });
});
```

- [ ] **Step 2: Run the UI helper tests to verify they fail**

Run: `bun test packages/ui/src/lib/api.test.ts packages/ui/src/lib/present.test.ts`

Expected: FAIL because `packages/ui` does not exist yet.

- [ ] **Step 3: Scaffold the Next.js package and helper modules**

```json
{
  "name": "@agentmeets/ui",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "bun test"
  },
  "dependencies": {
    "next": "15.0.7",
    "react": "18.3.1",
    "react-dom": "18.3.1"
  }
}
```

```ts
export function presentRoomLinks(input: {
  hostAgentLink: string;
  guestAgentLink: string;
}) {
  return {
    yourAgentInstruction: `Tell your agent to join this chat: ${input.hostAgentLink}`,
    otherAgentInstruction: `Tell the other agent to join this chat: ${input.guestAgentLink}`,
  };
}
```

- [ ] **Step 4: Re-run the UI helper tests**

Run: `bun test packages/ui/src/lib/api.test.ts packages/ui/src/lib/present.test.ts`

Expected: PASS with a buildable `packages/ui` scaffold and browser-facing instruction helpers.

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "build: scaffold agentmeets room ui package"
```

### Task 7: Build the create form, result page, and expired state with `innies`-style visuals

**Files:**
- Create: `packages/ui/src/app/rooms/[roomStem]/page.tsx`
- Create: `packages/ui/src/app/rooms/[roomStem]/page.module.css`
- Create: `packages/ui/src/app/api/rooms/route.ts`
- Create: `packages/ui/src/app/api/rooms/[roomStem]/route.ts`
- Create: `packages/ui/src/components/CreateRoomForm.tsx`
- Create: `packages/ui/src/components/CreateRoomForm.test.tsx`
- Create: `packages/ui/src/components/RoomResult.tsx`
- Create: `packages/ui/src/components/RoomResult.test.tsx`
- Create: `packages/ui/src/components/ExpiredRoomState.tsx`
- Create: `packages/ui/src/components/ExpiredRoomState.test.tsx`
- Modify: `packages/ui/src/app/page.tsx`
- Modify: `packages/ui/src/app/page.module.css`
- Test: `packages/ui/src/components/CreateRoomForm.test.tsx`
- Test: `packages/ui/src/components/RoomResult.test.tsx`
- Test: `packages/ui/src/components/ExpiredRoomState.test.tsx`

- [ ] **Step 1: Write the failing UI component tests**

```tsx
test("CreateRoomForm requires a starting message before submit", async () => {
  render(<CreateRoomForm />);
  expect(screen.getByRole("button", { name: /create room/i })).toBeDisabled();
});

test("RoomResult renders both related links and copy-ready instructions", () => {
  render(
    <RoomResult
      roomStem="r_9wK3mQvH8"
      hostAgentLink="https://agentmeets.test/j/r_9wK3mQvH8.1"
      guestAgentLink="https://agentmeets.test/j/r_9wK3mQvH8.2"
    />,
  );

  expect(screen.getByText(/tell your agent to join this chat/i)).toBeTruthy();
  expect(screen.getByText(/tell the other agent to join this chat/i)).toBeTruthy();
});

test("ExpiredRoomState renders the dead-end recovery action", () => {
  render(<ExpiredRoomState />);
  expect(screen.getByRole("link", { name: /create new room/i })).toHaveAttribute("href", "/");
});
```

- [ ] **Step 2: Run the UI component tests to verify they fail**

Run: `bun test packages/ui/src/components/CreateRoomForm.test.tsx packages/ui/src/components/RoomResult.test.tsx packages/ui/src/components/ExpiredRoomState.test.tsx`

Expected: FAIL because the components and browser proxy routes do not exist yet.

- [ ] **Step 3: Implement the UI screens and route handlers**

```tsx
export default function HomePage() {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.console}>
          <h1 className={styles.title}>start a room</h1>
          <p className={styles.prompt}>rooms expire after 10 minutes of inactivity</p>
          <CreateRoomForm />
        </section>
      </div>
    </main>
  );
}
```

```ts
export async function POST(request: Request) {
  const payload = await request.json();
  return proxyToServer("/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
```

```tsx
const room = await getPublicRoom(params.roomStem);
if (room.kind === "expired") {
  return <ExpiredRoomState />;
}
return <RoomResult {...room} />;
```

- [ ] **Step 4: Re-run the UI component tests**

Run: `bun test packages/ui/src/components/CreateRoomForm.test.tsx packages/ui/src/components/RoomResult.test.tsx packages/ui/src/components/ExpiredRoomState.test.tsx`

Expected: PASS with create/result/expired browser states and the `innies`-style console shell.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/app packages/ui/src/components
git commit -m "feat: add browser room create and result ui"
```

### Task 8: Update docs and run the full verification pass

**Files:**
- Modify: `README.md`
- Modify: `packages/server/tests/e2e/invite-flow.test.ts`
- Create: `packages/server/tests/e2e/browser-room.test.ts`
- Modify: `packages/mcp-server/src/index.test.ts`
- Modify: `packages/ui/package.json`
- Test: `packages/server/tests/e2e/browser-room.test.ts`
- Test: `packages/server/tests/e2e/invite-flow.test.ts`
- Test: `packages/ui/src/**/*.test.ts`

- [ ] **Step 1: Write the failing end-to-end and docs-oriented assertions**

```ts
test("browser-created room returns two related participant links and can be consumed by agents", async () => {
  expect(body.hostAgentLink).toContain(".1");
  expect(body.guestAgentLink).toContain(".2");
});

test("README documents the browser room create flow as a first-class path", async () => {
  expect(readme).toContain("Create room");
  expect(readme).toContain("Tell your agent to join this chat");
});
```

- [ ] **Step 2: Run the focused verification to verify the new assertions fail**

Run: `cd packages/server && bun test tests/e2e/browser-room.test.ts tests/e2e/invite-flow.test.ts`

Expected: FAIL until the browser-safe route/result flow and docs are updated.

- [ ] **Step 3: Update docs and any missing integration seams**

```md
## Browser Room UI

1. Open the AgentMeets room UI.
2. Type the starting message.
3. Click `Create room`.
4. Share the returned participant link with the other agent.
5. Rooms expire after 10 minutes of inactivity.
```

- [ ] **Step 4: Run the full verification suite**

Run: `cd packages/server && bun test`

Run: `bun test packages/session-helper/src/cli.test.ts`

Run: `bun test packages/mcp-server/src/index.test.ts`

Run: `bun test packages/ui/src/**/*.test.ts`

Run: `npx tsc -p packages/session-helper/tsconfig.json --noEmit`

Run: `npx tsc -p packages/mcp-server/tsconfig.json --noEmit`

Run: `cd packages/ui && bun run build`

Expected: PASS across server, MCP, helper CLI, and UI package builds/tests.

- [ ] **Step 5: Commit**

```bash
git add README.md packages/server/tests/e2e packages/mcp-server/src/index.test.ts packages/ui/package.json bun.lock
git commit -m "docs: add browser room creation flow"
```

## Execution Notes

- Start implementation from the integrated zero-setup branch or merged equivalent, not the older room-code-only baseline.
- Keep the UI package visually aligned with `innies`, but do not import code directly from the `innies` repo.
- If `bun.lock` changes after adding `packages/ui` or new testing dependencies, commit that change intentionally in the final UI/doc task.
- If the existing session-helper runtime cannot fully auto-start the host side from MCP without widening scope too far, preserve the role-link-based `hostHelperCommand` contract and document the gap explicitly instead of inventing a browser fallback.
- Do not remove the old `/rooms/:id/join` compatibility route until the paired-link UI and CLI flow are both verified.
