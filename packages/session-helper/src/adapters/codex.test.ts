import { describe, expect, test } from "bun:test";

describe("CodexAdapter", () => {
  test("injects remote messages with Codex-specific control prompt formatting", async () => {
    const module = await import("./codex.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const writes: string[] = [];
    const adapter = new module.CodexAdapter({
      writeToPty(chunk: string) {
        writes.push(chunk);
      },
    });

    await adapter.injectRemoteMessage({
      remoteRole: "host",
      content: "Confirm the rollback and summarize the root cause.",
    });

    expect(writes).toEqual([
      [
        "[agentmeets codex remote-message]",
        "remote_role=host",
        "draft_command=/draft <message>",
        "---",
        "Confirm the rollback and summarize the root cause.",
        "",
      ].join("\n"),
    ]);
  });

  test("shows draft mode controls including originalDraft while preserving the first draft", async () => {
    const module = await import("./codex.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const writes: string[] = [];
    const adapter = new module.CodexAdapter({
      writeToPty(chunk: string) {
        writes.push(chunk);
      },
    });

    await adapter.enterDraftMode({
      originalDraft: "Initial summary for Codex.",
      workingDraft: "Initial summary for Codex.",
    });

    expect(writes[0]).toBe(
      [
        "[agentmeets codex draft-mode]",
        "originalDraft:",
        "Initial summary for Codex.",
        "workingDraft:",
        "Initial summary for Codex.",
        "controls: /regenerate | /end",
        "",
      ].join("\n"),
    );

    expect(adapter.routeDraftCommand("/regenerate")).toEqual({
      kind: "regenerate_draft",
      originalDraft: "Initial summary for Codex.",
      workingDraft: "Initial summary for Codex.",
    });

    await adapter.enterDraftMode({
      originalDraft: "This replacement must be ignored.",
      workingDraft: "Second pass with tighter wording.",
    });

    expect(writes[1]).toBe(
      [
        "[agentmeets codex draft-mode]",
        "originalDraft:",
        "Initial summary for Codex.",
        "workingDraft:",
        "Second pass with tighter wording.",
        "controls: /regenerate | /end",
        "",
      ].join("\n"),
    );

    expect(adapter.routeDraftCommand("/end")).toEqual({
      kind: "end_session",
    });
  });

  test("injects host-ready prompts that tell Codex to call the MCP host_meet tool", async () => {
    const module = await import("./codex.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const writes: string[] = [];
    const adapter = new module.CodexAdapter({
      writeToPty(chunk: string) {
        writes.push(chunk);
      },
    });

    await adapter.injectHostReadyPrompt({
      participantLink: "https://agentmeets.test/j/r_9wK3mQvH8.1",
    });

    expect(writes).toEqual([
      [
        "[agentmeets codex host-ready]",
        "participant_link=https://agentmeets.test/j/r_9wK3mQvH8.1",
        "connect_tool=host_meet",
        'connect_args={"participantLink":"https://agentmeets.test/j/r_9wK3mQvH8.1"}',
        "draft_command=/draft <message>",
        "controls=/regenerate|/end",
        "",
      ].join("\n"),
    ]);
  });

  test("injects guest-ready prompts that tell Codex to call the MCP guest_meet tool", async () => {
    const module = await import("./codex.js").catch(() => null);

    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const writes: string[] = [];
    const adapter = new module.CodexAdapter({
      writeToPty(chunk: string) {
        writes.push(chunk);
      },
    });

    await adapter.injectGuestReadyPrompt({
      participantLink: "https://agentmeets.test/j/r_9wK3mQvH8.2",
    });

    expect(writes).toEqual([
      [
        "[agentmeets codex guest-ready]",
        "participant_link=https://agentmeets.test/j/r_9wK3mQvH8.2",
        "connect_tool=guest_meet",
        'connect_args={"participantLink":"https://agentmeets.test/j/r_9wK3mQvH8.2"}',
        "draft_command=/draft <message>",
        "controls=/regenerate|/end",
        "",
      ].join("\n"),
    ]);
  });
});

describe("createSessionAdapter", () => {
  test("resolves both claude-code and codex adapters from the CLI", async () => {
    const codexModule = await import("./codex.js").catch(() => null);
    const claudeModule = await import("./claude-code.js").catch(() => null);
    const cliModule = await import("../cli.js").catch(() => null);

    expect(codexModule).not.toBeNull();
    expect(claudeModule).not.toBeNull();
    expect(cliModule).not.toBeNull();
    if (!codexModule || !claudeModule || !cliModule) {
      return;
    }

    const codexAdapter = cliModule.createSessionAdapter({
      adapterName: "codex",
      writeToPty() {},
    });
    const claudeAdapter = cliModule.createSessionAdapter({
      adapterName: "claude-code",
      writeToPty() {},
    });

    expect(codexAdapter).toBeInstanceOf(codexModule.CodexAdapter);
    expect(claudeAdapter).toBeInstanceOf(claudeModule.ClaudeCodeAdapter);
  });
});
