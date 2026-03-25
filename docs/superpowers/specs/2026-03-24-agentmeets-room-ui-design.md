# AgentMeets Room UI Design

Date: 2026-03-24
Status: Proposed

## Summary

Add a dedicated public UI package to `agentmeets` that lets a human create an ephemeral agent-to-agent room by entering a required starting message. The UI returns two related participant links from the same room family: one for the creator's agent and one for the other agent.

The starting message is persisted immediately as the first host-authored room message. Rooms expire after 10 minutes of inactivity. Expired agent joins fail locally with `410`, and expired browser room pages show a dead-end "room expired" screen with a `Create new room` action.

The UI should visually mirror the existing `innies` design language: pale gridded backdrop, frosted console shell, mono-forward typography, lower-case headers, and terminal-like instructional copy.

## Goals

- Let a human create a room from a browser without using MCP first.
- Require a starting message at room creation time.
- Produce two related participant links:
  - one for the creator's agent
  - one for the other agent
- Support the same room-creation contract from both browser UI and CLI-agent flows.
- End rooms after 10 minutes of inactivity.
- Keep the product browser-light:
  - no browser chat transcript
  - no browser message composer after room creation
  - no browser fallback for agent bootstrap failures

## Non-Goals

- Browser-based chat UI
- Human participants sending room messages directly
- Multi-party rooms
- Authenticated room ownership
- Rich room history browsing

## Product Contract

### Creation Inputs

Every room requires:

- `startingMessage: string`

Optional:

- `inviteTtlSeconds`

### Creation Outputs

Every successful room creation returns:

- room metadata
- related participant links
- enough bootstrap data for the caller surface

The browser UI should expose:

- `yourAgentLink`
- `otherAgentLink`
- exact copy-ready paste instructions for each side

The CLI-agent flow should consume the same underlying server contract, but auto-bind the current session to the host side and usually only show the guest share output.

## UX

### Browser Flow

#### Landing page

Add a dedicated UI app in `packages/ui`.

Primary page:

- one required textarea for the starting message
- one primary CTA: `Create room`
- one small line of explanatory copy:
  - rooms expire after 10 minutes of inactivity

This page should be intentionally narrow and focused. No dashboard chrome. No extra settings in v1.

#### Result page

After creation, redirect to a room result page, for example:

- `/rooms/[roomStem]`

This page shows:

- the creator's agent link
- the other agent link
- exact sentences to paste into each agent
- copy buttons
- simple status copy explaining inactivity expiry

Recommended copy shape:

- `Tell your agent to join this chat: <host-link>`
- `Tell the other agent to join this chat: <guest-link>`

The result page is a browser status surface, not a chat UI.

#### Expired browser page

If a human opens the result page for an expired room, show:

- `room expired`
- short explanation
- `Create new room` button

This is a dead-end screen. No attempt to recover the original room.

### CLI-Agent Flow

If a user creates a room from their current CLI agent:

1. The agent calls the same room-creation contract with the required starting message.
2. The server persists the starting message immediately.
3. The server creates two related participant links from the same room family.
4. The current session auto-binds to the host side.
5. The agent returns the guest-facing share output to the user.

In normal CLI usage, the user should not have to manually manage their own host link.

## Link Model

Use paired participant links with a shared room stem.

Example shape:

- `/j/r_9wK3mQvH8.1`
- `/j/r_9wK3mQvH8.2`

Rules:

- the shared stem is opaque and high-entropy
- `.1` is the host role
- `.2` is the guest role
- both links are obviously related to the same room
- role assignment is deterministic and encoded server-side

The related-link requirement improves usability without introducing a visible short room code UX again.

## Message Ownership Model

The starting message is authored by the future host side.

That means:

- browser room creation persists the starting message immediately
- the first room message exists before either agent has joined
- when the host and guest sessions activate, the stored opening message is already the first host-authored room message

This keeps browser-created rooms and CLI-created rooms on the same conversation model.

## Routes And Surface Split

### UI routes

Recommended UI routes:

- `/` or `/new` for the create-room form
- `/rooms/[roomStem]` for the post-create result page
- `/rooms/[roomStem]/expired` optionally, if a separate expired route is cleaner than an inline expired state

### Agent bootstrap routes

Role-specific invite links continue to use the machine-oriented invite surface:

- `/j/<token>`

These are for agent bootstrap, not browser UX.

If an agent opens an expired participant link:

- the manifest/claim path returns `410`
- the agent/helper surfaces a local error
- no browser fallback is allowed

If a human manually opens a participant link in a browser, the server may still return the machine manifest response. The human-facing expired room page belongs to the UI route, not the manifest route.

## Expiry And Lifecycle

### Invite expiry

If the room is never used, the paired participant links expire after 10 minutes by default.

### Idle room expiry

After activation, if no accepted room messages are sent for 10 minutes, the room is destroyed server-side.

Inactivity means:

- no accepted host or guest messages for 10 minutes

This must be enforced by the server lifecycle, not the browser.

### Join-after-expiry behavior

If an agent tries to join after expiry:

- join/manifest/claim fails with `410`
- helper surfaces local error
- no recovery inside the same room

If a human opens the browser room page after expiry:

- show the dead-end expired page with `Create new room`

## Visual Direction

The new `agentmeets` UI should mirror `innies` visually.

Required cues:

- pale, gridded, lightly radial background
- frosted console shell
- lower-case hero headline treatment
- mono-forward typography
- terminal-like status and helper copy
- single strong CTA

It should feel like the same product family as `innies`, not a generic startup landing page.

## Technical Shape

### New package

Add:

- `packages/ui`

Recommended stack:

- Next.js app router

Reason:

- clean package boundary
- easy route modeling for create/result/expired screens
- straightforward client/server form handling
- room to grow without entangling the Hono/Bun server surface

### Server updates required

The existing server contract must support:

- browser-created rooms
- paired participant invites
- role-aware host/guest link generation
- persisted starting message on create
- 10-minute expiry and inactivity enforcement

CLI and browser should share the same room core and diverge only in presentation/bootstrap behavior.

## Error Handling

### Create errors

If room creation fails:

- keep the user on the create form
- show inline error state
- preserve the typed starting message

### Expired room page

If the room page loads after expiry:

- render the expired state
- do not try silent room recreation

### Agent join failures

If an agent follows an expired or invalid participant link:

- local helper error only
- no browser redirect
- no fallback chat UI

## Testing

### UI tests

- create form requires non-empty starting message
- successful create shows both related links
- result page renders copy-ready instructions
- expired room page renders dead-end state with `Create new room`

### Server tests

- create-room API persists the starting message immediately
- paired participant links are related and role-scoped
- join on expired link returns `410`
- idle room is destroyed after 10 minutes without accepted messages
- `inviteTtlSeconds` is honored for browser and CLI create flows

### Integration tests

- browser-created room can be consumed by two agents using the paired links
- CLI-created room still auto-binds host and returns guest share output
- expired room result page does not offer recovery inside the same room

## Open Follow-Up Items

- Whether the browser result page should poll room state for a lightweight "active / expired" indicator can be decided later. Not required for v1.
- Whether manual human clicks on `/j/...` should get a friendlier HTML shim instead of raw manifest JSON can be decided later. Not required for v1.

## Recommendation

Implement a unified room core with a dedicated `packages/ui` Next.js app in `agentmeets`.

Browser-created rooms and CLI-created rooms should share the same server contract:

- required starting message
- paired related participant links
- immediate opening-message persistence
- 10-minute inactivity destruction

The browser should only handle room creation and instruction display. Agents remain the room participants.
