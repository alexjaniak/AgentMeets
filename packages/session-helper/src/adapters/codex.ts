import type { SessionAdapter, SessionTranscriptMessage } from "./types.js";

const DEFAULT_DRAFT_COMMAND = "/draft <message>";

export interface CodexAdapterOptions {
  writeToPty: (chunk: string) => void | Promise<void>;
  initialTranscript?: SessionTranscriptMessage[];
  draftCommand?: string;
}

export interface CodexRemoteMessage {
  remoteRole: "host" | "guest";
  content: string;
}

export interface CodexDraftState {
  originalDraft: string;
  workingDraft: string;
}

export type CodexDraftCommand =
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

export class CodexAdapter implements SessionAdapter {
  #transcript: SessionTranscriptMessage[];
  #writeToPty: CodexAdapterOptions["writeToPty"];
  #draftCommand: string;
  #draftState: CodexDraftState | null = null;

  constructor({
    writeToPty,
    initialTranscript = [],
    draftCommand = DEFAULT_DRAFT_COMMAND,
  }: CodexAdapterOptions) {
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
  }: CodexRemoteMessage): Promise<void> {
    this.#transcript.push({
      role: "user",
      content,
    });

    await this.#writeToPty(
      [
        "[agentmeets codex remote-message]",
        `remote_role=${remoteRole}`,
        `draft_command=${this.#draftCommand}`,
        "---",
        content,
        "",
      ].join("\n"),
    );
  }

  async enterDraftMode({
    originalDraft,
    workingDraft,
  }: CodexDraftState): Promise<void> {
    const preservedOriginalDraft =
      this.#draftState?.originalDraft ?? originalDraft;

    this.#draftState = {
      originalDraft: preservedOriginalDraft,
      workingDraft,
    };

    await this.#writeToPty(
      [
        "[agentmeets codex draft-mode]",
        "originalDraft:",
        preservedOriginalDraft,
        "workingDraft:",
        workingDraft,
        "controls: /regenerate | /end",
        "",
      ].join("\n"),
    );
  }

  routeDraftCommand(input: string): CodexDraftCommand | null {
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
    await this.#writeToPty(
      [
        "[agentmeets codex host-ready]",
        `participant_link=${participantLink}`,
        `draft_command=${this.#draftCommand}`,
        "controls=/regenerate|/end",
        "",
      ].join("\n"),
    );
  }
}

function cloneMessage(
  message: SessionTranscriptMessage,
): SessionTranscriptMessage {
  return { ...message };
}
