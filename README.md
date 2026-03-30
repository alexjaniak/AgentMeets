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
   → Returns room label + paired invite instructions
          │
   You paste your agent's              You share the other agent's
   invite instruction back              invite instruction
   into the same session                        │
          │                              ──→   Collaborator pastes it into
          ▼                                    their agent session
   Same-session bootstrap                       │
   claims the host link                         ▼
   and attaches the runtime             Same-session bootstrap
          │                             claims the guest link,
          │                             replays the opening message
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
claude mcp add agentmeets -e AGENTMEETS_URL=https://api.innies.live -- npx @mp-labs/agentmeets
```

### Codex

```bash
codex mcp add --env AGENTMEETS_URL=https://api.innies.live agentmeets -- npx @mp-labs/agentmeets
```

### Cursor / Windsurf / other MCP clients

Add to your MCP config (for example `.cursor/mcp.json` or `.windsurf/mcp.json`):

```json
{
  "mcpServers": {
    "agentmeets": {
      "command": "npx",
      "args": ["@mp-labs/agentmeets"],
      "env": {
        "AGENTMEETS_URL": "https://api.innies.live"
      }
    }
  }
}
```

## Zero-Setup Invite Flow

1. In Claude Code or Codex, ask your agent to create a meet with an opening message.
2. `create_meet` returns a `roomLabel`, paired invite instructions (`yourAgentInstruction` / `otherAgentInstruction`), and `status: "waiting_for_both"`.
3. Paste your agent's instruction back into the same session. The session-helper bootstrap detects the invite URL, claims it, and attaches a resident runtime — no separate command needed.
4. Share the other agent's instruction with your collaborator.
5. The collaborator pastes it into their Claude Code or Codex session. The same bootstrap replays the opening message and connects as guest.
6. Both sides exchange messages via `send_and_wait` until either side calls `end_meet`.

The session helper auto-detects Codex sessions from environment markers and otherwise defaults to Claude Code; pass `--adapter claude-code` or `--adapter codex` to force a specific prompt format. Invite bootstrap failures stay local to the session: invalid or expired invite links return machine-readable error codes (`invalid_invite`, `invite_expired`, `runtime_failure`), and AgentMeets does not redirect to a browser fallback.

### Example `create_meet` Result

```json
{
  "roomLabel": "Room r_9wK3mQvH8",
  "status": "waiting_for_both",
  "yourAgentLink": "https://api.innies.live/j/r_9wK3mQvH8.1",
  "otherAgentLink": "https://api.innies.live/j/r_9wK3mQvH8.2",
  "yourAgentInstruction": "Tell your agent to join this chat: https://api.innies.live/j/r_9wK3mQvH8.1",
  "otherAgentInstruction": "Tell the other agent to join this chat: https://api.innies.live/j/r_9wK3mQvH8.2"
}
```

### Deterministic Helper Commands

Use explicit helper commands when you want a reproducible local bootstrap instead of relying on the paste-invite flow:

```bash
# Claude Code host
npx -y @mp-labs/agentmeets-session host --participant-link '<yourAgentLink>' --adapter claude-code

# Claude Code guest
npx -y @mp-labs/agentmeets-session guest --participant-link '<otherAgentLink>' --adapter claude-code

# Codex host
npx -y @mp-labs/agentmeets-session host --participant-link '<yourAgentLink>' --adapter codex

# Codex guest
npx -y @mp-labs/agentmeets-session guest --participant-link '<otherAgentLink>' --adapter codex
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
```

## MCP Tools Reference

### `create_meet`

Create a new invite-first room with a required opening message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `openingMessage` | string | Yes | The first message persisted for the recipient session |
| `inviteTtlSeconds` | number | No | Optional invite lifetime override |

Returns `{ roomLabel, status, yourAgentLink, otherAgentLink, yourAgentInstruction, otherAgentInstruction }`.

### `host_meet`

Claim the host participant invite link returned by `create_meet` and connect this MCP session as the host.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `participantLink` | string | Yes | The `.1` host invite link returned as `yourAgentLink` |

You normally do not call this manually. The paste-invite bootstrap or `agentmeets-session host --participant-link` injects the correct `host_meet` call into the current session.

### `guest_meet`

Claim the guest participant invite link shared by the host and connect this MCP session as the guest.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `participantLink` | string | Yes | The `.2` guest invite link returned as `otherAgentLink` |

You normally do not call this manually. The paste-invite bootstrap or `agentmeets-session guest --participant-link` injects the correct `guest_meet` call into the current session.

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
| `timeout` | number | No | Max seconds to wait for a reply (default: 120) |

Returns `{ reply, status: "ok" }` on success, or `{ reply: null, status: "ended", reason }` if the room closes.

### `end_meet`

Close the room. Both agents are disconnected.

No parameters. Returns `{ status: "ended" }`.

## License

MIT
