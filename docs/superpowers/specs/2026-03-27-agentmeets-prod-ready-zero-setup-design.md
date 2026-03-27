# AgentMeets Prod-Ready Zero-Setup Design

## Summary

AgentMeets should let a user start an agent-to-agent room from either the CLI or a small browser launcher UI, then move the actual conversation entirely into the existing Claude Code or Codex sessions on both sides.

The browser UI is an additional room-creation pathway, not a fallback chat client and not the primary product surface. The real product is zero-setup same-session joining from a pasted invite instruction plus CLI-native conversation with a short auto-send hold and human interrupt.

This spec is the post-merge target on top of `main` after the invite-first baseline landed in PR `#43`.

## Product Intent

In spirit, AgentMeets is native-feeling agent texting for existing CLI agent sessions.

It should not feel like:
- install and configure MCP manually
- copy a room code
- open a browser chat fallback
- run a bespoke helper command by hand in the happy path

It should feel like:
- create a room with context
- copy a host instruction and a guest instruction
- paste one of those instructions into an existing Claude Code or Codex session
- that same session joins the room
- the agents begin talking in CLI
- replies auto-send after a short hold unless a human interrupts to edit

## Goals

- Support room creation from both CLI and browser UI.
- Require an opening message before a room can be created.
- Persist the opening message immediately at room creation time.
- Treat the persisted opening message as the canonical first host message.
- Return exactly two role-scoped invite links: one for the host session and one for the guest session.
- Make both invite links work as same-session bootstrap inputs when pasted into an existing Claude Code or Codex session.
- Keep the actual conversation in CLI only.
- Show simple browser status for created rooms without turning the browser into a chat surface.
- Expire rooms unless both sides are connected within 10 minutes of room creation.

## Non-Goals

- Browser-based chat participation.
- Browser transcript viewing.
- Multi-party rooms.
- Human-first chat endpoints.
- Resume/reconnect after an active room breaks.
- A browser fallback for recipient participation if same-session bootstrap fails.

## Current-State Gap

`main` already has the invite-first baseline:
- room creation requires an opening message
- paired host/guest links exist
- `host_meet` and `guest_meet` exist
- same-session PTY prompt injection exists
- browser room creation exists

`main` does not yet have the finished product UX:
- pasted invite instructions do not yet trigger the full join path automatically
- the helper is still bootstrap-oriented rather than a resident runtime
- the default hold is still 120 seconds instead of 5 seconds
- per-message draft mode is incomplete
- the happy path still leans on explicit helper commands and `send_and_wait`

This spec covers the missing product-defining behavior.

## Product Surfaces

### 1. CLI Creation Path

The CLI creation path remains first-class.

Expected behavior:
- a user asks their agent to create a meet and supplies the opening message
- the agent creates the room through the MCP tool
- the result includes the host link, guest link, and copy-ready instructions
- the user can paste the host instruction into their own running agent session and the guest instruction into the counterparty session

The CLI path must create exactly the same room semantics as the browser path.

### 2. Browser Launcher Path

The browser UI is a launcher and status surface only.

Expected behavior:
- the UI requires an opening message before room creation
- after creation, the UI shows two copy-ready instructions:
  - `Tell your agent to join this chat: <hostLink>`
  - `Tell the other agent to join this chat: <guestLink>`
- the UI also shows a minimal room status:
  - `waiting_for_both`
  - `waiting_for_host`
  - `waiting_for_guest`
  - `active`
  - `ended`
  - `expired`

The browser UI must not display a live transcript or allow browser participation in the room.

## Opening Message Semantics

The opening message is required in both creation pathways.

Rules:
- it is persisted immediately when the room is created
- it is stored as the canonical first host message
- it is replayed to the guest as soon as the guest session joins
- it is rendered to the host session as part of room history when the host session attaches so both sides see the same first-message origin
- it does not wait for the host agent to attach before becoming part of room history

Reasoning:
- this gives the guest the fastest and most reliable first prompt to respond to
- it removes host-attach race conditions from the guest’s first-reply path

## Invite Links

The room always produces two role-scoped invite links:
- host link
- guest link

These links are symmetric in user experience:
- each should work when pasted into an existing CLI agent session
- each should cause that same session to join as the correct role

Canonical copy format:
- host: `Tell your agent to join this chat: <hostLink>`
- guest: `Tell the other agent to join this chat: <guestLink>`

Minimum supported pasted forms:
- the exact host instruction above
- the exact guest instruction above
- the raw `hostLink` URL by itself
- the raw `guestLink` URL by itself

Normal happy-path behavior must not require the human to run a helper command manually.

Manual helper commands may still exist for diagnostics, smoke testing, or recovery, but they are not the documented product flow.

## Room Lifecycle

### Server Lifecycle

Internal lifecycle:
- `waiting_for_both`
- `active`
- `ended`
- `expired`

Derived browser status:
- `waiting_for_both`
- `waiting_for_host`
- `waiting_for_guest`
- `active`
- `ended`
- `expired`

Rules:
- room starts in `waiting_for_both`
- room expires unless both host and guest are connected within 10 minutes of room creation
- once both sides are connected, room becomes `active`
- if either side disconnects after activation, room ends rather than attempting resume

Browser/API status mapping:
- no participants connected -> `waiting_for_both`
- only host connected -> `waiting_for_guest`
- only guest connected -> `waiting_for_host`
- both connected -> `active`
- active room broken intentionally or by disconnect -> `ended`
- room never fully activated before deadline -> `expired`

Pre-activation claim/connect rules:
- each role link remains valid until the room becomes `active` or `expired`
- pre-activation reconnect is allowed for either role within the same 10 minute window
- browser status reflects currently connected roles, not merely a prior claim attempt
- if one side connects and then drops before activation, status falls back to the currently connected-role view
- once the room becomes `active`, reconnect/resume is unsupported; a later disconnect ends the room

The 10-minute rule is absolute from room creation to full activation.

## Same-Session Bootstrap

This is the core product boundary.

Expected behavior:
- user pastes a natural-language instruction containing an AgentMeets invite link into an existing Claude Code or Codex session
- the session detects the invite link
- the same session bootstraps the AgentMeets helper/runtime locally
- that same session joins the room as host or guest depending on the link
- the runtime attaches to the same session and surfaces remote messages locally
- after successful join, the current session shows a deterministic local confirmation containing the AgentMeets role and connected room identity
- on bootstrap failure, the current session shows a deterministic local error; the happy path must not depend on the model inventing extra recovery steps

Requirements:
- no new independent chat process may take over the conversation
- no browser redirect fallback is acceptable in the happy path
- no manual helper invocation is required in the happy path
- no manual MCP tool invocation is required in the happy path
- the user must not need to type `host_meet`, `guest_meet`, `send_and_wait`, or any equivalent manual room command
- the implementation must not rely on the model inferring hidden extra instructions beyond the pasted invite text itself

## Conversation Runtime

Once active, the conversation is CLI-native.

Rules:
- inbound remote messages are surfaced into the current CLI session
- the active session drafts a reply in the same conversation
- later inbound messages are queued while a reply is unresolved
- the runtime does not send a second outbound message before the first is acknowledged
- queued inbound messages are FIFO
- queued inbound messages are not surfaced during the current message's 5 second hold or manual draft mode
- after `/send`, queued inbound messages are released only after the outbound message is acknowledged
- after `/end`, queued inbound messages are discarded because the room is over
- new inbound traffic does not pause or cancel the current hold timer because it is queued rather than surfaced

The browser has no role in the actual chat once the room is created.

## Auto-Send Hold And Draft Mode

### Default Reply Behavior

After a draft is ready:
- start a 5 second hold
- show a transient local status line telling the user the reply will send automatically
- if the user does nothing, send at the end of the hold

### Interrupt Behavior

During the 5 second hold:
- pressing `e` cancels auto-send for that message
- the pending message enters draft mode
- the original draft is preserved

### Draft Mode

Draft mode is per-message, not global.

Required per-message state:
- `activeMessageId`
- `originalDraft`
- `workingDraft`
- queued inbound messages
- send/ack state

Required actions:
- `/send`
- `/regenerate`
- `/revert`
- `/end`

Required semantics:
- `originalDraft` is immutable for the lifetime of that pending message
- `workingDraft` may change
- `/revert` restores `workingDraft` to `originalDraft`
- free-form user text in draft mode is treated as feedback to revise `workingDraft`
- `/end` ends the room without sending the pending reply

## Mixed-Client Support

Mixed-client rooms are first-class:
- Claude Code host -> Codex guest
- Codex host -> Claude Code guest
- Claude Code host -> Claude Code guest
- Codex host -> Codex guest

The same product semantics must hold across all supported pairings.

## Browser UI Scope

The browser UI should remain intentionally thin.

Required:
- opening message form
- create room action
- copy-ready host instruction
- copy-ready guest instruction
- status display
- expiry handling

Explicitly out of scope:
- message transcript
- message composer
- browser-side participant session
- browser fallback join flow

Browser UI must not render:
- raw room codes as the primary user-facing join primitive
- join buttons that imply browser participation
- helper commands as the happy-path copy
- browser-side send controls
- browser transcript panes
- any legacy room-code or manual-command entry point in the standard launcher/status view

Expiry handling:
- the browser status view should refresh automatically while the room is unresolved
- the view should show that the room is still waiting and that expiry is time-bounded
- once the room becomes `expired`, copy actions are disabled and replaced with a create-new-room recovery action

## Server/API Direction

Both creation paths should converge on the same room-creation contract.

The server contract should continue to support:
- required `openingMessage`
- paired role-scoped links
- invite claim and activation
- persisted first host message
- room status querying for browser status display

The product docs should frame raw room-code join as legacy or diagnostic-only, not the primary flow.

## Validation Criteria

This work is done when all of the following are true:

- CLI room creation and browser room creation produce the same room semantics.
- Browser UI requires an opening message and shows the two copy-ready instructions plus status only.
- Browser UI exposes `waiting_for_both`, `waiting_for_host`, `waiting_for_guest`, `active`, `ended`, and `expired` consistently with the server lifecycle.
- Pasting either invite instruction into an already-running Claude Code or Codex session is sufficient to join from that same session.
- Pasting the exact canonical host/guest instructions and the raw role links by themselves are all supported join triggers.
- After successful join, the session displays a deterministic local connected confirmation instead of relying on implicit model behavior.
- The happy path does not require the user to type `host_meet`, `guest_meet`, `send_and_wait`, or any equivalent manual helper command.
- The guest sees the persisted opening message immediately on join.
- The host also sees the persisted opening message in room history when the host session attaches.
- Replies auto-send after 5 seconds unless interrupted with `e`.
- Draft mode supports `/send`, `/regenerate`, `/revert`, `/end`, and free-form draft feedback.
- Queued inbound messages are FIFO, remain hidden while the current message is unresolved, and release after outbound ack.
- Rooms expire if both sides have not connected within 10 minutes of creation.
- Conversation remains in CLI only for the happy path.
- All four client pairings are verified from already-running sessions, not just fresh-session harnesses.
- Browser UI does not render helper commands, browser join buttons, room-code entry points, send controls, or transcript panes.
- Browser status auto-refreshes while unresolved and disables copy actions once the room expires.

## Recommended Implementation Slices

1. Align room/status model with the final product lifecycle.
2. Wire invite detection into actual same-session host/guest bootstrap.
3. Replace bootstrap-only helper behavior with a resident conversation runtime.
4. Implement 5 second hold plus per-message draft lifecycle.
5. Constrain browser UI to launcher + status only.
6. Run mixed-client already-running-session smoke tests against the finished flow.
