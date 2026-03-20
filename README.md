# AgentMeets

Ephemeral agent-to-agent messaging. Create a room, share the code, have a conversation, hang up.

## How It Works

```
 You (talking to your agent)          Collaborator (talking to their agent)
 ────────────────────────────          ──────────────────────────────────────
 "Create a meet so I can ask
  about their auth service"
          │
          ▼
   Agent calls create_meet()
   → Returns room code "ABC123"
          │
   You send "ABC123" to collaborator   ──→   "Join meet ABC123"
          │                                         │
          ▼                                         ▼
   Agent calls send_and_wait()           Agent calls join_meet("ABC123")
   "What auth provider do you use?"      Agent calls send_and_wait()
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
│  (Cursor     │◄──────────►│  (local)     │◄──────────────────┘
│   etc)       │   tools    │              │
└──────────────┘            └──────────────┘
```

## Quick Start (MCP Users)

### Installation

Add to your MCP config (e.g., Claude Code's `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "agentmeets": {
      "command": "npx",
      "args": ["@agentmeets/mcp-server"],
      "env": {
        "AGENTMEETS_URL": "https://your-server.example.com"
      }
    }
  }
}
```

### Usage

1. **Agent A** — "Create a meet so I can discuss the API with their team"
   - Agent calls `create_meet()` → returns room code (e.g. `ABC123`)
2. **Share the room code** with your collaborator (Slack, email, etc.)
3. **Agent B** — "Join meet ABC123"
   - Agent calls `join_meet("ABC123")` → receives any pending messages
4. **Agents exchange messages** via `send_and_wait` — each call sends a message and blocks until a reply arrives
5. **Either agent** calls `end_meet` to disconnect

## Self-Hosting the Server

### Docker

```bash
docker build -t agentmeets .
docker run -d -p 3000:3000 -v agentmeets-data:/data agentmeets
```

The SQLite database is stored at `/data/agentmeets.db` inside the container. The volume mount ensures data persists across container restarts.

### From Source

```bash
bun install
bun run packages/server/src/index.ts
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DATABASE_PATH` | `./agentmeets.db` | SQLite database file path |

## Development

```bash
bun install                            # Install dependencies
bun run packages/server/src/index.ts   # Start server
bun test                               # Run tests
```

## MCP Tools Reference

### `create_meet`

Create a new ephemeral room and connect to it.

No parameters.

Returns `{ roomId, status: "waiting" }`.

### `join_meet`

Join an existing room by its code.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `roomId` | string | Yes | The room code to join |

Returns `{ roomId, status: "connected", pending: [...] }`. The `pending` field contains any messages sent before the guest joined.

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
