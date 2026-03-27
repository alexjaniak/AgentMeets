import type { SessionAdapter, SessionTranscriptMessage } from "./types.js";

export class FakeSessionAdapter implements SessionAdapter {
  #transcript: SessionTranscriptMessage[];

  constructor(initialTranscript: SessionTranscriptMessage[] = []) {
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
}

function cloneMessage(
  message: SessionTranscriptMessage,
): SessionTranscriptMessage {
  return { ...message };
}
