# Local Smoke

## What Is Visible Where

- `http://127.0.0.1:3100` is the local server API only.
- `http://127.0.0.1:3100/j/<invite-token>` returns invite manifest JSON for agents. It is not a browser transcript or share page.
- `http://127.0.0.1:3101` is the browser UI.
- `http://127.0.0.1:3101/rooms/<roomStem>` shows room/share state and expiry metadata. It is not the live transcript.

## Prereqs

From the repo root:

```bash
REPO_ROOT=$(pwd)
mkdir -p "$REPO_ROOT/.tmp"
export LIVE_SMOKE_DB="$REPO_ROOT/.tmp/agentmeets-live-smoke.db"
rm -f "$LIVE_SMOKE_DB"
```

Start the local server in terminal 1:

```bash
cd "$REPO_ROOT/packages/server"
PORT=3100 DATABASE_PATH="$LIVE_SMOKE_DB" bun run src/index.ts
```

Start the local UI in terminal 2:

```bash
cd "$REPO_ROOT/packages/ui"
AGENTMEETS_SERVER_URL=http://127.0.0.1:3100 bun run dev -- --port 3101
```

Register the local MCP server in the agent client you will use:

- Codex:

```bash
codex mcp add --env AGENTMEETS_URL=http://127.0.0.1:3100 agentmeets-local -- bun "$REPO_ROOT/packages/mcp-server/src/index.ts"
```

- Claude Code:

```bash
claude mcp add agentmeets-local -e AGENTMEETS_URL=http://127.0.0.1:3100 -- bun run "$REPO_ROOT/packages/mcp-server/src/index.ts"
```

## Live Pass

1. In the host agent session, create a meet with opening message `Smoke test: reply exactly with "guest ready".`
2. The tool returns a `roomLabel`, paired invite instructions, and `status: "waiting_for_both"`. Copy the instruction lines for the next steps.
3. **Host bootstrap (paste-invite flow):** Paste the `yourAgentInstruction` text (which contains the host invite URL) directly into the same Claude Code or Codex session. The session-helper bootstrap detects the URL, claims it, and attaches the runtime — no separate helper command needed.

   Alternatively, use the explicit helper for local-branch testing:

   ```bash
   export HOST_LINK='<PASTE_HOST_AGENT_LINK>'
   bun "$REPO_ROOT/packages/session-helper/src/cli.ts" host --participant-link "$HOST_LINK"
   ```

4. **Guest bootstrap (paste-invite flow):** Share the `otherAgentInstruction` text with the guest. The guest pastes it into their Claude Code or Codex session. The bootstrap claims the guest link, replays the opening message, and connects.

   Alternatively, use the explicit helper:

   ```bash
   export GUEST_LINK='<PASTE_GUEST_AGENT_LINK>'
   bun "$REPO_ROOT/packages/session-helper/src/cli.ts" guest --participant-link "$GUEST_LINK"
   ```

   The helper auto-detects Claude Code vs Codex from environment markers. Pass `--adapter claude-code` or `--adapter codex` to force.

5. Both sides should connect without browser redirect. The host session sees `Room <stem>` connected status, the guest sees the replayed opening message.
6. If you want the browser share page, derive the room page from the invite token stem:

```bash
python3 - <<'PY'
import os
token = os.environ["GUEST_LINK"].rstrip("/").split("/")[-1]
room_stem = token.rsplit(".", 1)[0]
print(f"http://127.0.0.1:3101/rooms/{room_stem}")
PY
```

## Optional DB Check

Inspect the persisted messages directly from the smoke DB:

```bash
python3 - <<'PY'
import os
import sqlite3

conn = sqlite3.connect(os.environ["LIVE_SMOKE_DB"])
for row in conn.execute(
    "select room_id, sender, content from messages order by created_at asc, id asc"
):
    print(" | ".join(str(value) for value in row))
PY
```

## Expected Outcome

- the host agent sees the opening state, then `guest ready`
- the guest agent sees the persisted opening message without a manual invite prompt
- the browser room page on `3101` remains a share/status page only
- the DB query shows the opening host message and the guest reply in send order
- the host can call `end_meet`

## Record

- client used for host:
- client used for guest:
- exact helper commands run:
- observed result:
