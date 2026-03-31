import type { SessionAdapter, SessionTranscriptMessage } from "./types.js";

const DEFAULT_DRAFT_COMMAND = "/draft <message>";

export interface ClaudeCodeAdapterOptions {
  writeToPty: (chunk: string) => void | Promise<void>;
  initialTranscript?: SessionTranscriptMessage[];
  draftCommand?: string;
}

export interface ClaudeCodeRemoteMessage {
  remoteRole: "host" | "guest";
  content: string;
}

export interface ClaudeCodeDraftState {
  originalDraft: string;
  workingDraft: string;
}

export type ClaudeCodeDraftCommand =
  | {
      kind: "submit_draft";
      content: string;
    }
  | {
      kind: "regenerate_draft";
      originalDraft: string;
      workingDraft: string;
    }
  | {
      kind: "end_session";
    };

export class ClaudeCodeAdapter implements SessionAdapter {
  #transcript: SessionTranscriptMessage[];
  #writeToPty: ClaudeCodeAdapterOptions["writeToPty"];
  #draftCommand: string;
  #draftState: ClaudeCodeDraftState | null = null;

  constructor({
    writeToPty,
    initialTranscript = [],
    draftCommand = DEFAULT_DRAFT_COMMAND,
  }: ClaudeCodeAdapterOptions) {
    this.#writeToPty = writeToPty;
    this.#draftCommand = draftCommand;
    this.#transcript = initialTranscript.map(cloneMessage);
  }

  async getTranscript(): Promise<SessionTranscriptMessage[]> {
    return this.#transcript.map(cloneMessage);
  }

  async appendOutboundAssistantMessage(content: string): Promise<void> {
    this.#transcript.push({
      role: "assistant",
      content,
    });
  }

  async injectRemoteMessage({
    remoteRole,
    content,
  }: ClaudeCodeRemoteMessage): Promise<void> {
    this.#transcript.push({
      role: "user",
      content,
    });

    await this.#writePrompt(
      [
        "[agentmeets remote-message]",
        `remote-role: ${remoteRole}`,
        "message:",
        content,
        `submit-final-draft: ${this.#draftCommand}`,
        "",
      ].join("\n"),
    );
  }

  async enterDraftMode({
    originalDraft,
    workingDraft,
  }: ClaudeCodeDraftState): Promise<void> {
    const preservedOriginalDraft =
      this.#draftState?.originalDraft ?? originalDraft;

    this.#draftState = {
      originalDraft: preservedOriginalDraft,
      workingDraft,
    };

    await this.#writePrompt(
      [
        "[agentmeets draft-mode]",
        "original-draft:",
        preservedOriginalDraft,
        "working-draft:",
        workingDraft,
        "controls:",
        "/regenerate",
        "/end",
        "",
      ].join("\n"),
    );
  }

  routeDraftCommand(input: string): ClaudeCodeDraftCommand | null {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return null;
    }

    if (trimmed === "/regenerate") {
      if (!this.#draftState) {
        return null;
      }

      return {
        kind: "regenerate_draft",
        originalDraft: this.#draftState.originalDraft,
        workingDraft: this.#draftState.workingDraft,
      };
    }

    if (trimmed === "/end") {
      return { kind: "end_session" };
    }

    if (!trimmed.startsWith("/draft")) {
      return null;
    }

    const content = trimmed.slice("/draft".length).trim();
    if (content.length === 0) {
      return null;
    }

    return {
      kind: "submit_draft",
      content,
    };
  }

  async injectHostReadyPrompt({
    participantLink,
  }: {
    participantLink: string;
  }): Promise<void> {
    await this.#writeReadyPrompt({
      promptKind: "host-ready",
      participantLink,
      connectTool: "host_meet",
    });
  }

  async injectGuestReadyPrompt({
    participantLink,
  }: {
    participantLink: string;
  }): Promise<void> {
    await this.#writeReadyPrompt({
      promptKind: "guest-ready",
      participantLink,
      connectTool: "guest_meet",
    });
  }

  async #writeReadyPrompt({
    promptKind,
    participantLink,
    connectTool,
  }: {
    promptKind: "host-ready" | "guest-ready";
    participantLink: string;
    connectTool: "host_meet" | "guest_meet";
  }): Promise<void> {
    await this.#writePrompt(
      [
        `[agentmeets ${promptKind}]`,
        `participant-link: ${participantLink}`,
        `connect-tool: ${connectTool}`,
        `connect-args: {"participantLink":"${participantLink}"}`,
        `submit-final-draft: ${this.#draftCommand}`,
        "draft-controls: /regenerate | /end",
        "",
      ].join("\n"),
    );
  }

  async #writePrompt(prompt: string): Promise<void> {
    await this.#writeToPty(prompt);
  }
}

function cloneMessage(
  message: SessionTranscriptMessage,
): SessionTranscriptMessage {
  return { ...message };
}
