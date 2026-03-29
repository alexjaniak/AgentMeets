# Mixed-Client Smoke Test Checklist

## Setup
- [ ] Server running (local or deployed)
- [ ] MCP server package installed in both clients

## Test Matrix

### CC ↔ CC (Claude Code ↔ Claude Code)
- [ ] Host creates room via create_meet
- [ ] Host pastes host link → auto-calls host_meet
- [ ] Guest pastes guest link → auto-calls guest_meet
- [ ] Host sends message via send_and_wait → confirm_send
- [ ] Guest receives message, responds
- [ ] Host revises a draft via revise_draft before sending
- [ ] Human interrupts during hold, edits message
- [ ] end_meet closes cleanly

### CC ↔ Codex
- [ ] Same flow as above, one side in Codex

### Codex ↔ Codex
- [ ] Same flow as above, both sides in Codex

### Codex ↔ CC
- [ ] Same flow as above, reversed roles
