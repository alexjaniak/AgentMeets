# Baseline Consolidation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the invite-first AgentMeets work that is currently spread across multiple dirty worktrees into one committed baseline branch.

**Architecture:** Start from the verified shared base commit (`82356e5`), copy the union state already assembled in `smoke-test-runbook`, then run the baseline verification gate and commit the result as a single branch for follow-on productization work.

**Tech Stack:** Bun, TypeScript, MCP server, AgentMeets server/UI/session-helper packages, SQLite-backed smoke tooling

---

## Chunk 1: Create The Consolidation Branch

### Task 1: Create a clean isolated worktree from the current invite-flow base

**Files:**
- Create: `docs/superpowers/plans/2026-03-27-baseline-consolidation.md`
- Verify: repository root worktree state

- [x] **Step 1: Create the new worktree and branch**

Run: `git worktree add ~/.config/superpowers/worktrees/AgentMeets/baseline-consolidated-state -b baseline-consolidated-state 82356e5`

- [x] **Step 2: Install dependencies in the new worktree**

Run: `bun install`

- [x] **Step 3: Verify the shared base commit is green before consolidation**

Run: `bun test`
Expected: full suite passes from the clean base so later failures are attributable to consolidation.

## Chunk 2: Copy The Union State

### Task 2: Treat `smoke-test-runbook` as the synthetic source of truth

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `packages/mcp-server/src/index.ts`
- Create: `packages/mcp-server/src/controller.ts`
- Create: `packages/mcp-server/src/controller.test.ts`
- Modify: `packages/server/src/db/index.ts`
- Modify: `packages/server/src/db/invites.ts`
- Modify: `packages/server/src/db/messages.ts`
- Modify: `packages/server/src/db/rooms.ts`
- Modify: `packages/server/src/ws/room-manager.ts`
- Modify: `packages/server/src/ws/upgrade.ts`
- Modify: `packages/server/tests/e2e/browser-room.test.ts`
- Modify: `packages/server/tests/ws.test.ts`
- Modify: `packages/session-helper/src/adapters/claude-code.ts`
- Modify: `packages/session-helper/src/adapters/claude-code.test.ts`
- Modify: `packages/session-helper/src/adapters/codex.ts`
- Modify: `packages/session-helper/src/adapters/codex.test.ts`
- Modify: `packages/session-helper/src/cli.ts`
- Modify: `packages/session-helper/src/cli.test.ts`
- Create/Modify: `docs/**`
- Create/Modify: `scripts/**`

- [ ] **Step 1: Copy the tracked and untracked union files from `smoke-test-runbook` into this worktree**

Run: targeted `rsync`/copy commands for only the changed paths listed above.

- [ ] **Step 2: Verify the resulting worktree contains the full union change set**

Run: `git status --short`
Expected: only the intended consolidation files appear.

## Chunk 3: Verify And Commit The Baseline

### Task 3: Run the branch gate and publish one committed baseline branch

**Files:**
- Verify: all files from Chunk 2

- [ ] **Step 1: Run the targeted verification gate**

Run:
- `bun test packages/mcp-server/src/controller.test.ts packages/mcp-server/src/index.test.ts`
- `bun test packages/session-helper/src/cli.test.ts packages/session-helper/src/adapters/claude-code.test.ts packages/session-helper/src/adapters/codex.test.ts`
- `bun test packages/server/tests/e2e/browser-room.test.ts packages/server/tests/e2e/invite-flow.test.ts packages/server/tests/ws.test.ts`
- `npx tsc -p packages/mcp-server/tsconfig.json --noEmit`
- `npx tsc -p packages/session-helper/tsconfig.json --noEmit`
- `bun run smoke:packages`

- [ ] **Step 2: Run hygiene checks**

Run:
- `git diff --check`
- `git status --short`

- [ ] **Step 3: Commit the consolidated baseline**

Run:
```bash
git add README.md package.json docs scripts packages
git commit -m "feat: consolidate invite-first baseline state"
```

- [ ] **Step 4: Record the post-consolidation baseline for the next planning pass**

Capture:
- branch name
- commit SHA
- verification commands and results
- known missing prod-ready UX behaviors to scope next
