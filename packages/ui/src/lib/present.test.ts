import { describe, expect, test } from "bun:test";
import { presentRoomLinks } from "./present.js";

describe("presentRoomLinks", () => {
  test("labels the two related participant links for browser UX", () => {
    expect(
      presentRoomLinks({
        hostAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.1",
        guestAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.2",
      }),
    ).toEqual({
      yourAgentInstruction:
        "Tell your agent to join this chat: https://agentmeets.test/j/r_9wK3mQvH8.1",
      otherAgentInstruction:
        "Tell the other agent to join this chat: https://agentmeets.test/j/r_9wK3mQvH8.2",
    });
  });
});
