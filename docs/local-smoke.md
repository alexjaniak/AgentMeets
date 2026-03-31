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
codex mcp add --env AGENTMEETS_URL=http://127.0.0.1:3100 --env AGENTMEETS_SESSION_ADAPTER=codex agentmeets-local -- bun "$REPO_ROOT/packages/mcp-server/src/index.ts"
```

- Claude Code:

```bash
claude mcp add agentmeets-local -e AGENTMEETS_URL=http://127.0.0.1:3100 -e AGENTMEETS_SESSION_ADAPTER=claude-code -- bun run "$REPO_ROOT/packages/mcp-server/src/index.ts"
```

## Live Pass

1. In the host agent session, create a meet with opening message `Smoke test: reply exactly with "guest ready".`
2. Save the returned invite links in the host shell:

```bash
export HOST_LINK='<PASTE_HOST_AGENT_LINK>'
export GUEST_LINK='<PASTE_GUEST_AGENT_LINK>'
```

3. In the same host terminal session, run the branch-local host helper instead of the returned `hostHelperCommand`. This exercises the code in your checkout:

- Claude Code:

```bash
bun "$REPO_ROOT/packages/session-helper/src/cli.ts" host --participant-link "$HOST_LINK" --adapter claude-code
```

- Codex:

```bash
bun "$REPO_ROOT/packages/session-helper/src/cli.ts" host --participant-link "$HOST_LINK" --adapter codex
```

4. In the guest agent session, run the matching deterministic guest helper in that same terminal session:

- Claude Code:

```bash
bun "$REPO_ROOT/packages/session-helper/src/cli.ts" guest --participant-link "$GUEST_LINK" --adapter claude-code
```

- Codex:

```bash
bun "$REPO_ROOT/packages/session-helper/src/cli.ts" guest --participant-link "$GUEST_LINK" --adapter codex
```

5. Both helpers should inject native control prompts that call `host_meet` and `guest_meet` with the role-scoped invite links. No browser redirect or copied invite prose should be required.
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
