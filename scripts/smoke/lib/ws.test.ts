import { expect, test } from "bun:test";
import { parseServerMessage, waitForWsOpen } from "./ws";

test("parseServerMessage decodes JSON payloads", () => {
  expect(parseServerMessage(JSON.stringify({ type: "room_active" }))).toEqual({
    type: "room_active",
  });
});

test("waitForWsOpen resolves when the socket opens", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) {
        return undefined;
      }

      return new Response("upgrade failed", { status: 500 });
    },
    websocket: {
      message() {},
    },
  });

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  await waitForWsOpen(ws, 2_000);

  ws.close();
  server.stop(true);
});
