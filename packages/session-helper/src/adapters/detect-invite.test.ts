import { describe, expect, test } from "bun:test";
import { detectInvite } from "./detect-invite.js";
import { FakeSessionAdapter } from "./fake-session.js";
import type { SessionTranscriptMessage } from "./types.js";

describe("detectInvite", () => {
  test("returns normalized invite metadata for the first invite URL in plain text", () => {
    expect(
      detectInvite(
        "Join here: https://agentmeets.example/j/invite-token_123?via=chat#intro.",
      ),
    ).toEqual({
      inviteToken: "invite-token_123",
      inviteUrl: "https://agentmeets.example/j/invite-token_123",
    });
  });

  test("accepts paired participant invite tokens with dotted role suffixes", () => {
    expect(
      detectInvite(
        "Use this link: https://agentmeets.example/j/r_9wK3mQvH8.1?via=chat#intro.",
      ),
    ).toEqual({
      inviteToken: "r_9wK3mQvH8.1",
      inviteUrl: "https://agentmeets.example/j/r_9wK3mQvH8.1",
    });
  });

  test("returns null when plain text does not contain an invite URL", () => {
    expect(
      detectInvite("No invite here, only a room path: /rooms/ABC123/join"),
    ).toBeNull();
  });
});

describe("FakeSessionAdapter", () => {
  test("preserves seeded transcript entries when the caller mutates its input array", async () => {
    const seededTranscript: SessionTranscriptMessage[] = [
      { role: "user", content: "Can you share the invite?" },
    ];

    const adapter = new FakeSessionAdapter(seededTranscript);
    seededTranscript.push({
      role: "assistant",
      content: "This mutation should stay outside the adapter.",
    });

    expect(await adapter.getTranscript()).toEqual([
      { role: "user", content: "Can you share the invite?" },
    ]);
  });

  test("appends outbound assistant-visible messages to the transcript", async () => {
    const adapter = new FakeSessionAdapter([
      { role: "user", content: "Please send the invite." },
    ]);

    await adapter.appendOutboundAssistantMessage(
      "Join me at https://agentmeets.example/j/spike-token",
    );

    expect(await adapter.getTranscript()).toEqual([
      { role: "user", content: "Please send the invite." },
      {
        role: "assistant",
        content: "Join me at https://agentmeets.example/j/spike-token",
      },
    ]);
  });
});
