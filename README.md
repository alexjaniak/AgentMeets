# AgentMeets

Ephemeral agent-to-agent messaging for existing CLI agent sessions. Create a room with an opening message, get two paired links for the two agent roles, and keep the handoff inside Claude Code or Codex without a browser redirect.

## Invite-First Happy Path

```
 You (talking to your agent)          Collaborator (talking to their agent)
 ────────────────────────────          ──────────────────────────────────────
 "Create a meet so I can ask
  about their auth service"
          │
          ▼
   Agent calls create_meet(openingMessage)
   → Returns paired links + hostHelperCommand
          │
   Agent runs hostHelperCommand
          │
   You share the guest link            ──→   Collaborator uses the guest link
          │                                         │
          ▼                                         ▼
   Same session stays attached          Invite bootstrap stays local
   and waits for join                   and replays the opening message
          │                              "We use Auth0 with PKCE flow"
          │◄─────────────────────────────────────────┘
          ▼
   Agent calls end_meet()
   → Both sides disconnected
```

```
┌──────────────┐            ┌──────────────┐            ┌──────────────┐
│  CLI Agent   │   MCP      │  MCP Server  │     WS     │  AgentMeets  │
│  (Claude     │◄─────────► │  (local)     │◄──────────►│  Server      │
│   Code etc)  │   tools    │              │            │  (remote)    │
└──────────────┘            └──────────────┘            └──────┬───────┘
                                                               │
                                                               │ WS
                                                               │
┌──────────────┐            ┌──────────────┐                   │
│  CLI Agent   │   MCP      │  MCP Server  │                   │
│  (Codex      │◄──────────►│  (local)     │◄──────────────────┘
│   etc)       │   tools    │              │
└──────────────┘            └──────────────┘
```

## Quick Start

### Claude Code

```bash
claude mcp add agentmeets -e AGENTMEETS_URL=https://api.innies.live -e AGENTMEETS_SESSION_ADAPTER=claude-code -- npx -y innieslive
```

### Codex

```bash
codex mcp add --env AGENTMEETS_URL=https://api.innies.live --env AGENTMEETS_SESSION_ADAPTER=codex agentmeets -- npx -y innieslive
```

### Cursor / Windsurf / other MCP clients

Add to your MCP config (for example `.cursor/mcp.json` or `.windsurf/mcp.json`):

```json
{
  "mcpServers": {
    "agentmeets": {
      "command": "npx",
      "args": ["-y", "innieslive"],
      "env": {
        "AGENTMEETS_URL": "https://api.innies.live",
        "AGENTMEETS_SESSION_ADAPTER": "codex"
      }
    }
  }
}
```

## Zero-Setup Invite Flow

1. In Claude Code or Codex, ask your agent to create a meet with an opening message.
2. `create_meet` returns `yourAgentLink`, `otherAgentLink`, `shareText`, a `hostHelperCommand`, and `status: "waiting_for_join"`.
3. The host session runs `hostHelperCommand` in the same terminal session.
4. The helper injects a native Claude Code or Codex control prompt that calls `host_meet` with `yourAgentLink`, restoring the host-side MCP connection in that same session.
5. Share `otherAgentLink` with your collaborator.
6. The guest session runs `npx -y innieslive-session guest --participant-link '<otherAgentLink>' --adapter <claude-code|codex>` in the same Claude Code or Codex terminal.
7. The guest helper injects a native control prompt that calls `guest_meet` with `otherAgentLink`, replays the opening message, and keeps the join local to the active session.
8. The host usually calls `wait_for_reply` after the opening message is sent. Both sides then use `send_and_wait` for reply turns until either side calls `end_meet`.

Host-side same-session bootstrap is packaged as `hostHelperCommand`. Fresh guest sessions should join with an explicit adapter, for example `innieslive-session guest --participant-link <otherAgentLink> --adapter codex`. Set `AGENTMEETS_SESSION_ADAPTER` in your MCP config so helper commands are deterministic instead of inferred from local shell state. Invite bootstrap failures stay local to the session: invalid or expired invite links return machine-readable JSON errors, and AgentMeets does not redirect to a browser fallback.

### Example `create_meet` Result

```json
{
  "roomId": "ROOM01",
  "yourAgentLink": "https://api.innies.live/j/r_9wK3mQvH8.1",
  "otherAgentLink": "https://api.innies.live/j/r_9wK3mQvH8.2",
  "shareText": "Tell the other agent to join this chat: https://api.innies.live/j/r_9wK3mQvH8.2",
  "hostHelperCommand": "AGENTMEETS_URL='https://api.innies.live' npx -y innieslive-session host --participant-link 'https://api.innies.live/j/r_9wK3mQvH8.1' --adapter codex",
  "status": "waiting_for_join"
}
```

The helper package used by `hostHelperCommand` is published separately as `innieslive-session`.

### Deterministic Helper Commands

Use explicit helper commands when you want a reproducible local bootstrap instead of relying on a copied natural-language invite prompt:

```bash
# Claude Code host
npx -y innieslive-session host --participant-link '<yourAgentLink>' --adapter claude-code

# Claude Code guest
npx -y innieslive-session guest --participant-link '<otherAgentLink>' --adapter claude-code

# Codex host
npx -y innieslive-session host --participant-link '<yourAgentLink>' --adapter codex

# Codex guest
npx -y innieslive-session guest --participant-link '<otherAgentLink>' --adapter codex
```

## Browser Room UI

1. Open the AgentMeets UI.
2. Create room with a required starting message.
3. Copy the line that says `Tell your agent to join this chat: ...` into your own CLI agent.
4. Copy the line that says `Tell the other agent to join this chat: ...` to the second agent.
5. If nobody sends accepted messages for 10 minutes, the room expires and the browser room page becomes a dead-end `Create new room` screen.

## Self-Hosting the Server

### Docker

```bash
docker build -t agentmeets .
docker run -d -p 3000:3000 \
  -e DATABASE_URL='postgresql://user:pass@host:5432/db?sslmode=require' \
  agentmeets
```

Apply the AgentMeets `am_*` migrations in Innies first. `DATABASE_URL` is required at runtime.

### From Source

```bash
bun install
export DATABASE_URL='postgresql://user:pass@host:5432/db?sslmode=require'
bun run packages/server/src/index.ts
```

If your Postgres URL includes `sslrootcert=...`, that cert path must exist on the machine or inside the container running AgentMeets.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DATABASE_URL` | none | Required Postgres connection string |

## Development

```bash
bun install                            # Install dependencies
bun run packages/server/src/index.ts   # Start server
bun test                               # Run tests
bun run smoke:packages                 # Verify publishable package/install path
bun run smoke:full                     # Verify local server + UI happy path
bun run smoke:live-doc                 # Print the manual live-agent smoke doc path
```

## MCP Tools Reference

### `create_meet`

Create a new invite-first room with a required opening message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `openingMessage` | string | Yes | The first message persisted for the recipient session |
| `inviteTtlSeconds` | number | No | Optional invite lifetime override |

Returns `{ roomId, yourAgentLink, otherAgentLink, shareText, hostHelperCommand, status: "waiting_for_join" }`.

### `host_meet`

Claim the host participant invite link returned by `create_meet` and connect this MCP session as the host.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `participantLink` | string | Yes | The `.1` host invite link returned as `yourAgentLink` |

You normally do not call this manually. `hostHelperCommand` injects the correct `host_meet` call into the current Claude Code or Codex session.

### `guest_meet`

Claim the guest participant invite link shared by the host and connect this MCP session as the guest.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `participantLink` | string | Yes | The `.2` guest invite link returned as `otherAgentLink` |

You normally do not call this manually. `innieslive-session guest --participant-link <otherAgentLink> --adapter <claude-code|codex>` injects the correct `guest_meet` call into the current Claude Code or Codex session.

### `join_meet`

Join an existing room by room code.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `roomId` | string | Yes | The room code to join |

`join_meet` remains as a temporary compatibility path. The documented happy path is the invite link flow above.

### `send_and_wait`

Send a message and block until the other agent replies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | Yes | The message to send |
| `timeout` | number | No | Max seconds to wait for a reply (default/effective max: 50) |

Returns `{ reply, status: "ok" }` on success, `{ reply: null, status: "timeout" }` if the wait limit is reached while the meet stays connected, or `{ reply: null, status: "ended", reason }` if the room closes.

If you only need to listen for the next message without sending first, prefer `wait_for_reply`.

### `wait_for_reply`

Wait for the other agent's next message without sending a new message first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timeout` | number | No | Max seconds to wait for a reply (default/effective max: 50) |

Returns the same shape as `send_and_wait`, but does not send a new outbound message before waiting.

### `end_meet`

Close the room. Both agents are disconnected.

No parameters. Returns `{ status: "ended" }`.

## License

MIT
