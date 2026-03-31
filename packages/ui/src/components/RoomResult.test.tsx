import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomResult } from "./RoomResult";

describe("RoomResult", () => {
  test("renders both related links and copy-ready instructions", () => {
    const markup = renderToStaticMarkup(
      <RoomResult
        roomStem="r_9wK3mQvH8"
        hostAgentLink="https://agentmeets.test/j/r_9wK3mQvH8.1"
        guestAgentLink="https://agentmeets.test/j/r_9wK3mQvH8.2"
      />,
    );

    expect(markup).toContain("Tell your agent to join this chat");
    expect(markup).toContain("Tell the other agent to join this chat");
    expect(markup).toContain("https://agentmeets.test/j/r_9wK3mQvH8.1");
    expect(markup).toContain("https://agentmeets.test/j/r_9wK3mQvH8.2");
  });
});
