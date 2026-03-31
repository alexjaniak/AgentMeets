import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildGuestInstruction,
  buildHostInstruction,
  JoinInstructionsPane,
} from "./JoinInstructionsPane";

describe("JoinInstructionsPane", () => {
  test("renders setup, restart, and copy-send as explicit numbered steps", () => {
    const markup = renderToStaticMarkup(
      <JoinInstructionsPane
        openingMessage="Review the API transport failure."
        room={{
          roomId: "room_123",
          roomStem: "room_123",
          hostAgentLink: "https://api.innies.live/j/room_123.1",
          guestAgentLink: "https://api.innies.live/j/room_123.2",
          inviteExpiresAt: "2026-03-31T17:00:00.000Z",
          status: "waiting_for_join",
        }}
      />,
    );

    expect(markup).toContain("1. Run in your terminal:");
    expect(markup).toContain("2. Restart your Claude Code or Codex session");
    expect(markup).toContain("3. Copy and send using the buttons below");
    expect(markup).toContain("YOUR AGENT (HOST)");
    expect(markup).toContain("OTHER AGENT (GUEST)");
  });

  test("renders the copy-send step before the opening message preview", () => {
    const markup = renderToStaticMarkup(
      <JoinInstructionsPane
        openingMessage="Review the API transport failure."
        room={{
          roomId: "room_123",
          roomStem: "room_123",
          hostAgentLink: "https://api.innies.live/j/room_123.1",
          guestAgentLink: "https://api.innies.live/j/room_123.2",
          inviteExpiresAt: "2026-03-31T17:00:00.000Z",
          status: "waiting_for_join",
        }}
      />,
    );

    expect(markup.indexOf("3. Copy and send using the buttons below")).toBeLessThan(
      markup.indexOf("Opening Message"),
    );
  });

  test("builds explicit host and guest clipboard instructions", () => {
    const hostInstruction = buildHostInstruction("https://api.innies.live/j/room_123.1");
    const guestInstruction = buildGuestInstruction("https://api.innies.live/j/room_123.2");

    expect(hostInstruction).toContain("Join this Innies Live room as the host:");
    expect(hostInstruction).toContain("join https://api.innies.live/j/room_123.1");
    expect(hostInstruction).toContain("The opening message has already been sent.");
    expect(hostInstruction).toContain("Wait for the guest reply first.");

    expect(guestInstruction).toContain("Join this Innies Live room as the guest:");
    expect(guestInstruction).toContain("join https://api.innies.live/j/room_123.2");
    expect(guestInstruction).toContain("Read the host's opening message after joining.");
    expect(guestInstruction).toContain("Reply to it.");
  });
});
