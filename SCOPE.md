# AgentMeets Production Scope — Honest Status

Last updated: 2026-03-29

This document tracks every requirement from the [prod-ready spec](docs/superpowers/specs/2026-03-27-agentmeets-prod-ready-zero-setup-design.md) against what actually works today.

---

## How to Read This

- **DONE** — implemented, tested, works
- **PARTIAL** — some code exists but doesn't fulfill the requirement
- **NOT WORKING** — code exists but can't function in the target environment
- **NOT STARTED** — nothing exists

---

## 1. Room Creation (8/8 DONE)

| # | Requirement | Status |
|---|------------|--------|
| 1.1 | CLI creation via MCP `create_meet` tool | DONE |
| 1.2 | Browser UI creation via Next.js form | DONE |
| 1.3 | Opening message required (both paths) | DONE |
| 1.4 | Opening message persisted as first host message | DONE |
| 1.5 | Both paths produce same room semantics | DONE |
| 1.6 | Two role-scoped invite links returned | DONE |
| 1.7 | Copy-ready instructions in output | DONE |
| 1.8 | No raw room codes in standard output | DONE |

## 2. Invite System (7/7 DONE)

| # | Requirement | Status |
|---|------------|--------|
| 2.1 | Host link claim (`host_meet`) | DONE |
| 2.2 | Guest link claim (`guest_meet`) | DONE |
| 2.3 | Idempotent claiming | DONE |
| 2.4 | Token hashing in DB | DONE |
| 2.5 | Invite expiry (10 min) | DONE |
| 2.6 | Duplicate-role attach rejected | DONE |
| 2.7 | Pre-activation reconnect allowed | DONE |

## 3. Same-Session Bootstrap (0/8 — THE CRITICAL GAP)

This is the core product experience. None of it works.

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 3.1 | Paste invite into running Claude Code → auto-joins | NOT STARTED | Human must explicitly ask agent to call `host_meet`/`guest_meet`. Spec says "no manual MCP tool invocation required." |
| 3.2 | Paste invite into running Codex → auto-joins | NOT STARTED | Same. |
| 3.3 | Invite detection from pasted text | PARTIAL | `detect-invite.ts` regex exists. Never wired into MCP flow. |
| 3.4 | No manual helper command required in happy path | NOT MET | User must tell agent what to do. |
| 3.5 | Session-helper bootstraps automatically | NOT WORKING | `/dev/tty` returns `ENXIO` in Claude Code's Bash sandbox. PTY approach is dead. |
| 3.6 | Deterministic helper-rendered connected confirmation | NOT WORKING | `local-ui.ts` renders status strings. Can't display — no `/dev/tty`. |
| 3.7 | Deterministic helper-rendered error surfaces | NOT WORKING | Same. |
| 3.8 | Helper-rendered status surfaces (not assistant prose) | NOT WORKING | Same. |

**Why this is blocked:** The session-helper is designed to write to `/dev/tty` to render UI in the terminal. In Claude Code's execution environment, `/dev/tty` does not exist (`ENXIO: no such device or address`). The entire PTY-based approach cannot work.

## 4. Conversation Runtime (4/5)

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 4.1 | Inbound messages surfaced in CLI session | PARTIAL | `send_and_wait` returns reply in tool result. No live push between tool calls. |
| 4.2 | Agent drafts reply in same conversation | DONE | |
| 4.3 | Queued inbound messages (FIFO) | DONE | |
| 4.4 | No second outbound before first ack | DONE | |
| 4.5 | `send_and_wait` works for messaging | DONE | |

## 5. Auto-Send Hold — 5-Second Countdown (0/3 NOT WORKING)

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 5.1 | 5-second hold before auto-send | NOT WORKING | `countdown.ts` exists, tested. Needs `/dev/tty` raw mode for keypress. |
| 5.2 | Transient status line showing countdown | NOT WORKING | `local-ui.ts` renders it. Can't display. |
| 5.3 | Press `e` during hold → enter draft mode | NOT WORKING | Same `/dev/tty` blocker. |

## 6. Draft Mode — Human Intervention (0/9 in practice)

The state machine code exists and is well-tested in isolation. But none of it can run in Claude Code.

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 6.1 | Press `e` → enter draft mode | NOT WORKING | No keypress capture. |
| 6.2 | `originalDraft` / `workingDraft` state | DONE (isolated) | `draft-controller.ts` works. Not connected to anything. |
| 6.3 | `/send` sends workingDraft | DONE (isolated) | Same. |
| 6.4 | `/regenerate` requests new draft | DONE (isolated) | Same. |
| 6.5 | `/revert` restores originalDraft | DONE (isolated) | Same. |
| 6.6 | `/end` ends room | DONE | `end_meet` works. |
| 6.7 | Free-form text = draft feedback | DONE (isolated) | Adapter parses it. |
| 6.8 | Draft mode UI shown to human | NOT WORKING | No `/dev/tty`. |
| 6.9 | MCP staged-reply tools (`stage_reply`, `send_staged`, `revise_staged`) | DONE | Added + tested. But optional, not enforced. |

## 7. Pre-Activation Behavior (2/5)

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 7.1 | Guest sees opening message on join | DONE | Server replays history. |
| 7.2 | Host sees opening message on attach | DONE | Server replays history. |
| 7.3 | Guest can draft before activation | DONE (isolated) | Draft controller supports it. |
| 7.4 | Staged reply waits for activation | DONE (isolated) | Draft controller holds it. |
| 7.5 | Local UX shows "staged, waiting" | NOT WORKING | No `/dev/tty`. |

## 8. Browser UI (8/10)

| # | Requirement | Status |
|---|------------|--------|
| 8.1 | Opening message form | DONE |
| 8.2 | Create room action | DONE |
| 8.3 | Copy-ready host instruction | DONE |
| 8.4 | Copy-ready guest instruction | DONE |
| 8.5 | Status display with auto-refresh (5s poll) | DONE |
| 8.6 | Expiry handling (disable copy, show create-new) | DONE |
| 8.7 | No transcript/composer/join/send | DONE |
| 8.8 | Invite link browser landing (informational) | DONE |
| 8.9 | Landing says "paste into Claude Code/Codex" | DONE |
| 8.10 | Landing says "browser cannot join" | DONE |

## 9. Room Lifecycle (5/6)

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 9.1 | Full state machine | DONE | |
| 9.2 | Derived browser statuses | DONE | |
| 9.3 | 10-minute expiry from creation | DONE | |
| 9.4 | Disconnect after activation → ends | DONE | |
| 9.5 | Idle timeout (10 min no messages) | DONE | |
| 9.6 | Expired room → 410 on WS upgrade | BROKEN | Returns 500. `server.upgrade()` fails before expiry check. |

## 10. Mixed-Client Support (0/4)

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 10.1 | Claude Code ↔ Claude Code | PARTIAL | Agent messaging works. Human UX doesn't. |
| 10.2 | Claude Code ↔ Codex | NOT TESTED | |
| 10.3 | Codex ↔ Codex | NOT TESTED | |
| 10.4 | Same invite forms across clients | NOT STARTED | Bootstrap doesn't work for either. |

## 11. Deployment & Ops (1/10)

| # | Requirement | Status | Detail |
|---|------------|--------|--------|
| 11.1 | Server Dockerfile | DONE | |
| 11.2 | Server deployed | UNKNOWN | No fly.toml or deploy config found. |
| 11.3 | UI deployment | NOT DONE | No Vercel/Netlify config. Not in Dockerfile. |
| 11.4 | MCP package on npm | PARTIAL | Publish workflow exists. |
| 11.5 | Session-helper on npm | PARTIAL | Publish workflow exists. |
| 11.6 | CI test pipeline | NOT DONE | No test workflow. |
| 11.7 | CORS | NOT DONE | UI on different origin = broken. |
| 11.8 | Graceful shutdown | NOT DONE | Active connections hard-killed on deploy. |
| 11.9 | Request logging | NOT DONE | Zero access logs. |
| 11.10 | DB cleanup | NOT DONE | SQLite grows forever. |

---

## Summary

| Category | Done | Not Done |
|----------|------|----------|
| Room Creation | **8/8** | 0 |
| Invite System | **7/7** | 0 |
| Same-Session Bootstrap | **0/8** | 8 |
| Conversation Runtime | **4/5** | 1 |
| Auto-Send Hold | **0/3** | 3 |
| Draft Mode | **1/9** | 8 |
| Pre-Activation | **2/5** | 3 |
| Browser UI | **8/10** | 2 |
| Room Lifecycle | **5/6** | 1 |
| Mixed-Client | **0/4** | 4 |
| Deployment | **1/10** | 9 |

**Total: ~36 of 75 requirements done. The product-defining features (bootstrap + countdown + draft mode) are 1 of 20.**

---

## The Core Blocker

`/dev/tty` returns `ENXIO` in Claude Code's Bash sandbox. This kills:
- Session-helper PTY writes (all helper-rendered UI)
- Raw mode stdin (keypress detection for "press e to edit")
- Countdown display
- Draft mode display

The session-helper modules are well-built and tested but **cannot run in Claude Code's environment**.

## Paths Forward

1. **MCP-only approach** — Make human-in-the-loop work entirely through MCP tool call/result cycle. Agent must stage every reply. Human sees drafts in Claude Code's tool output. Human intervenes by talking to the agent. No terminal UX, no countdown keypress. Simpler, doesn't match spec's "press e" vision but is the only thing that works in Claude Code's sandbox.

2. **Separate terminal window** — Session-helper opens its own terminal (e.g. `open -a Terminal` on macOS) for the countdown/draft UI. MCP server communicates with it via IPC (unix socket, temp file, etc). Human presses `e` in that window. Complex but could deliver the full spec.

3. **Claude Code hooks/extensions** — If Claude Code supports MCP server notifications, progress events, or custom UI rendering, use that. Would need investigation.

4. **Revise the spec** — Accept Claude Code's constraints. Redefine "human in the loop" as the human talking to their agent normally. Agent stages drafts, human says "change X" or "send it". The agent is the intermediary. The 5-second auto-send becomes a tool-level default timeout.
