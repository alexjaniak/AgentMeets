import { describe, expect, test } from "bun:test";

describe("ClaudeCodeAdapter", () => {
  test("injects remote messages as deterministic control prompts with the draft helper command", async () => {
    const module = await import("./claude-code.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const writes: string[] = [];
    const adapter = new module.ClaudeCodeAdapter({
      writeToPty(chunk: string) {
        writes.push(chunk);
      },
    });

    await adapter.injectRemoteMessage({
      remoteRole: "guest",
      content: "Please summarize the outage and confirm the rollback.",
    });

    expect(writes).toEqual([
      [
        "[agentmeets remote-message]",
        "remote-role: guest",
        "message:",
        "Please summarize the outage and confirm the rollback.",
        "submit-final-draft: /draft <message>",
        "",
      ].join("\n"),
    ]);
  });

  test("routes explicit draft submissions and ignores ordinary assistant output", async () => {
    const module = await import("./claude-code.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const adapter = new module.ClaudeCodeAdapter({
      writeToPty() {},
    });

    expect(
      adapter.routeDraftCommand(
        "/draft We rolled back the release and service is stable again.",
      ),
    ).toEqual({
      kind: "submit_draft",
      content: "We rolled back the release and service is stable again.",
    });

    expect(
      adapter.routeDraftCommand("We rolled back the release automatically."),
    ).toBeNull();
  });

  test("enters draft mode with regenerate and end controls while preserving the original draft", async () => {
    const module = await import("./claude-code.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const writes: string[] = [];
    const adapter = new module.ClaudeCodeAdapter({
      writeToPty(chunk: string) {
        writes.push(chunk);
      },
    });

    await adapter.enterDraftMode({
      originalDraft: "Initial summary for the remote agent.",
      workingDraft: "Initial summary for the remote agent.",
    });

    expect(writes[0]).toBe(
      [
        "[agentmeets draft-mode]",
        "original-draft:",
        "Initial summary for the remote agent.",
        "working-draft:",
        "Initial summary for the remote agent.",
        "controls:",
        "/regenerate",
        "/end",
        "",
      ].join("\n"),
    );

    expect(adapter.routeDraftCommand("/regenerate")).toEqual({
      kind: "regenerate_draft",
      originalDraft: "Initial summary for the remote agent.",
      workingDraft: "Initial summary for the remote agent.",
    });

    await adapter.enterDraftMode({
      originalDraft: "This replacement must be ignored.",
      workingDraft: "Second pass with tighter wording.",
    });

    expect(writes[1]).toBe(
      [
        "[agentmeets draft-mode]",
        "original-draft:",
        "Initial summary for the remote agent.",
        "working-draft:",
        "Second pass with tighter wording.",
        "controls:",
        "/regenerate",
        "/end",
        "",
      ].join("\n"),
    );

    expect(adapter.routeDraftCommand("/end")).toEqual({
      kind: "end_session",
    });
  });
});
