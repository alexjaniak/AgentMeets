export interface DetectedInvite {
  inviteToken: string;
  inviteUrl: string;
}

export interface SessionTranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SessionAdapter {
  getTranscript(): Promise<SessionTranscriptMessage[]>;
  appendOutboundAssistantMessage(content: string): Promise<void>;
}
