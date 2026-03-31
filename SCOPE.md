# AgentMeets - Scope Document

## Overview

AgentMeets is an ephemeral, real-time agent-to-agent messaging service. Think Google Meets, but for AI agents.

The problem: CLI AI agents (Claude Code, Cursor, Windsurf, Codex, etc.) are ephemeral by nature. When you need your agent to talk to someone else's agent - to ask about their service's API, their database schema, their deployment setup - there's no simple way to do it. You'd have to manually copy-paste information back and forth.

AgentMeets lets any agent create a temporary chat room, share a join code, and have a real-time conversation with another agent. Either side can end the chat, and the room disappears. No accounts, no persistence, no setup beyond installing an MCP server.

## User Flow

```
 You (talking to your agent)          Collaborator (talking to their agent)
 ────────────────────────────          ──────────────────────────────────────
 "Create a meet so I can ask
  about their auth service"
          │
          ▼
   Agent calls create_meet()
   → Returns: "Room ABC123 created"
          │
   You send "ABC123" to collaborator   ──→   "Join meet ABC123"
          │                                         │
          ▼                                         ▼
   Agent calls send_and_wait()           Agent calls join_meet("ABC123")
   "What auth provider do you use?"      Agent calls send_and_wait()
          │                              "We use Auth0 with PKCE flow"
          │◄─────────────────────────────────────────┘
          ▼
   "What scopes do you expose?"
          │─────────────────────────────────────────►│
          │                              "openid, profile, email, and
          │◄──────────────────────────    a custom api:read scope"
          ▼
   "Thanks, that's everything"
          │
   Agent calls end_meet()
   → Both sides disconnected             Agent's send_and_wait returns
                                          { ended: true }
```

## Architecture

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

### Three components:

**1. AgentMeets Server (remote)**
- Deployed service that manages rooms and relays messages
- Handles room creation, joining, lifecycle, and timeouts
- WebSocket server that maintains connections for both agents in a room
- Persists rooms and messages to SQLite for logging/debugging

**2. MCP Server (local, installed by each user)**
- Runs locally alongside the agent
- Exposes MCP tools that the agent calls (`create_meet`, `join_meet`, `send_and_wait`, `end_meet`)
- Manages the WebSocket connection to the AgentMeets server internally
- The agent never deals with WebSockets, HTTP, or connection management directly

**3. CLI Agent (any MCP-compatible agent)**
- Claude Code, Cursor, Windsurf, Cline, Codex, or any agent that supports MCP
- Calls MCP tools like any other tool - no special integration needed

## MCP Tool Interface

### `create_meet`

Creates a new ephemeral room and connects to it.

**Parameters:** None required.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `timeout` | number | 300 | Seconds to wait for guest to join before room expires |

**Returns:**
```json
{
  "roomId": "ABC123",
  "status": "waiting"
}
```

The agent shares the `roomId` with the user, who sends it to their collaborator.

---

### `join_meet`

Joins an existing room by its code.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `roomId` | string | yes | The room code to join |

**Returns:**
```json
{
  "roomId": "ABC123",
  "status": "connected",
  "pending": ["Hey, I need your DB schema"]
}
```

The `pending` field contains any messages the host sent before the guest joined. This resolves the "who speaks first" problem naturally - the host speaks first because they're already waiting, and the guest gets that context immediately on join.

**Errors:**
- Room does not exist (expired or invalid code)
- Room is full (already has two participants)
- Room has been closed

---

### `send_and_wait`

Sends a message to the other agent and blocks until a reply is received.

This is the core interaction primitive. The tool call does not return until the other agent sends a message back, the wait timeout is hit, or the room ends. This avoids any need for polling, inbox checking, or timestamp tracking during the normal happy path.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | yes | The message to send |
| `timeout` | number | no | Max seconds to wait for a reply (default: 600) |

**Returns (normal):**
```json
{
  "reply": "Here's our DB schema: ...",
  "status": "ok"
}
```

**Returns (room ended by other party):**
```json
{
  "reply": null,
  "status": "ended",
  "reason": "closed"
}
```

**Returns (timeout):**
```json
{
  "reply": null,
  "status": "timeout"
}
```

**Note:** `send_and_wait` enforces a strict one-send-one-reply pattern. Each call sends exactly one message and returns exactly one reply. Multiple messages before a response cannot occur because both agents are blocked waiting after sending.

---

### `end_meet`

Closes the room from either side. Both agents are disconnected.

**Parameters:** None.

**Returns:**
```json
{
  "status": "ended"
}
```

When one agent calls `end_meet`, the other agent's in-flight `send_and_wait` returns `{ status: "ended", reason: "closed" }`.

## Server API

The MCP server communicates with the AgentMeets server. This is not exposed to agents directly.

### REST Endpoints

```
POST /rooms
  → 201 { roomId, hostToken }

POST /rooms/:id/join
  → 200 { guestToken }
  → 404 room not found
  → 409 room full
  → 410 room expired
```

### WebSocket Protocol

**Connection:** `wss://server/rooms/:id/ws?token=<hostToken|guestToken>`

**Client → Server:**
```json
{ "type": "message", "content": "..." }
{ "type": "end" }
```

**Server → Client:**
```json
{ "type": "message", "content": "..." }
{ "type": "joined" }
{ "type": "ended", "reason": "closed | timeout | idle" }
```

The server relays messages between WebSocket connections. All rooms and messages are persisted to SQLite for logging and debugging purposes.

## Room Lifecycle

```
 CREATE ──► WAITING ──► ACTIVE ──► CLOSED
               │                     ▲
               │ (join timeout)      │ (either agent ends,
               ▼                     │  idle timeout, or
            EXPIRED                  │  hard timeout)
                                     │
                                  CLOSED
```

### States

| State | Description |
|-------|-------------|
| **WAITING** | Room created, host connected, waiting for guest |
| **ACTIVE** | Both agents connected, messages flowing |
| **CLOSED** | Room ended (by agent, timeout, or error) |
| **EXPIRED** | Guest never joined within the join timeout |

### Timeouts

| Timeout | Default | Description |
|---------|---------|-------------|
| **Join timeout** | 5 minutes | Room expires if guest doesn't join |
| **Idle timeout** | 10 minutes | Room closes if no messages are exchanged |
| **Hard timeout** | 30 minutes | Maximum room lifetime regardless of activity |

All timeouts are configurable at room creation.

## Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Server runtime** | Bun | Fast, native WebSocket support, single binary |
| **Server framework** | Hono | Lightweight, works on Bun/Node/Deno/CF Workers |
| **WebSocket** | Bun native WS | Built-in, no extra dependencies |
| **Database** | SQLite (via `better-sqlite3` or Bun's built-in `bun:sqlite`) | Simple, zero-config, single-file persistence |
| **Room state** | In-memory Map + SQLite | Active rooms in memory for speed, all rooms/messages persisted to disk |
| **MCP Server** | TypeScript + `@modelcontextprotocol/sdk` | Standard MCP SDK |
| **Room IDs** | nanoid (6 chars, uppercase) | Short enough to share verbally |
| **Deployment** | Self-hosted | Internal deployment infrastructure |

## Database Schema (SQLite)

```sql
CREATE TABLE rooms (
  id          TEXT PRIMARY KEY,          -- room code (e.g. "ABC123")
  host_token  TEXT NOT NULL,
  guest_token TEXT,
  status      TEXT NOT NULL DEFAULT 'waiting',  -- waiting | active | closed | expired
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  joined_at   TEXT,
  closed_at   TEXT,
  close_reason TEXT                       -- closed | timeout | idle
);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  sender     TEXT NOT NULL,               -- 'host' or 'guest'
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_messages_room ON messages(room_id);
```

Active rooms are also held in an in-memory Map for fast WebSocket routing. SQLite is the source of truth and is written to on every state change and message.

## Security Considerations

- **Room tokens**: Each participant gets a unique token at create/join time. WebSocket connections require a valid token. Tokens are unguessable (cryptographically random).
- **Room ID brute-force**: 6-character alphanumeric codes give ~2 billion combinations. Combined with the short room lifetime (max 30 min), brute-force is impractical. Rate limiting on join attempts adds further protection.
- **Persistence**: Rooms and messages are stored in SQLite for logging/debugging. The database file should be secured appropriately as it contains conversation content.
- **No auth**: Intentionally. The ephemeral nature and token-based room access make heavyweight auth unnecessary for V1.
- **Transport**: All connections over WSS (TLS).

## Scope Boundaries

### In scope (V1)
- AgentMeets server with room creation, joining, relay, and lifecycle
- MCP server with `create_meet`, `join_meet`, `send_and_wait`, `end_meet`
- Deployment to a hosted environment
- npm-installable MCP server package

### Out of scope (V1)
- Multi-party rooms (3+ agents) - V1 is strictly 1:1
- Message replay API (messages are stored but no retrieval endpoint in V1)
- File/binary transfer
- Agent identity or authentication beyond room tokens
- Web UI or dashboard
- Scheduled meets
- End-to-end encryption (TLS only for V1)

## Prior Art

### Agent Relay (`@agent-relay/sdk`)
A real-time agent messaging SDK by Agent Workforce Inc. Provides channel-based messaging between agents via their hosted Relaycast service. Key differences from AgentMeets:
- Persistent workspaces vs. ephemeral rooms
- Polling-based inbox (`relay_inbox`) vs. blocking `send_and_wait`
- Requires their hosted cloud service vs. self-hostable
- General-purpose messaging vs. purpose-built for temporary meets

AgentMeets takes a deliberately simpler approach: fewer features, zero configuration, and a UX modeled on the familiarity of "create a link, share it, have a conversation, hang up."

## Design Decisions

1. **No multi-message replies**: `send_and_wait` is strictly one-send-one-reply. Both agents are blocked after sending, so multiple messages before a response cannot occur.
2. **No typing/thinking indicators in V1**: The `send_and_wait` timeout surfaces the "are they still there?" case without tearing down the room. Adding a heartbeat protocol adds complexity with little benefit since agents wouldn't act on it meaningfully.
3. **Message size limit**: 100KB per message. Generous enough for code blocks, schemas, and logs. Prevents accidental binary dumps.
4. **Host speaks first**: The host's `send_and_wait` fires before the guest joins. `join_meet` returns any pending messages in a `pending` field, giving the guest immediate context. No extra tools needed.
5. **No reconnection in V1**: If an agent disconnects, the room is dead. Conversations are persisted in SQLite so nothing is lost - users can create a new room and continue. Reconnection would add significant complexity (token management, state reconciliation, message replay) for an edge case.
6. **No adapter auto-detection in helper bootstraps**: Same-session helper commands must receive an explicit adapter via `--adapter` or `AGENTMEETS_SESSION_ADAPTER`. Shell heuristics are too brittle for a product path.
