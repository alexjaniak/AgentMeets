import { describe, expect, test } from "bun:test";
import { readCreateRoomResponse, readPublicRoomResponse } from "./api.js";

describe("readPublicRoomResponse", () => {
  test("maps expired 410 responses to an expired state", async () => {
    const response = new Response(JSON.stringify({ error: "room_expired" }), {
      status: 410,
      headers: { "content-type": "application/json" },
    });

    expect(await readPublicRoomResponse(response)).toEqual({
      kind: "expired",
    });
  });
});

describe("readCreateRoomResponse", () => {
  test("returns create-room payloads with waiting_for_both", async () => {
    const response = new Response(
      JSON.stringify({
        roomId: "ROOM01",
        roomStem: "r_9wK3mQvH8",
        hostAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.1",
        guestAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.2",
        inviteExpiresAt: "2026-03-25T18:12:00.000Z",
        status: "waiting_for_both",
      }),
      {
        status: 201,
        headers: { "content-type": "application/json" },
      },
    );

    expect(await readCreateRoomResponse(response)).toEqual({
      roomId: "ROOM01",
      roomStem: "r_9wK3mQvH8",
      hostAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.1",
      guestAgentLink: "https://agentmeets.test/j/r_9wK3mQvH8.2",
      inviteExpiresAt: "2026-03-25T18:12:00.000Z",
      status: "waiting_for_both",
    });
  });
});
