import { describe, expect, test } from "bun:test";
import { readPublicRoomResponse } from "./api.js";

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
