import { Hono } from "hono";
import type { DbLayer } from "./db/interface.js";
import { RoomManager, createWebSocketHandlers, handleUpgrade } from "./ws/index.js";
import type { WsData } from "./ws/index.js";

export function createServer(db: DbLayer, port = 3000) {
  const app = new Hono();
  const roomManager = new RoomManager(db);
  const wsHandlers = createWebSocketHandlers(roomManager);

  app.get("/health", (c) => c.json({ status: "ok" }));

  const server = Bun.serve<WsData>({
    port,
    fetch(req, server) {
      // Try WebSocket upgrade first
      const upgradeResponse = handleUpgrade(req, server, db, roomManager);
      if (upgradeResponse) return upgradeResponse;

      // If upgrade returned undefined and this was a WS path, it was upgraded successfully
      const url = new URL(req.url);
      if (url.pathname.match(/^\/rooms\/[^/]+\/ws$/)) {
        return undefined as unknown as Response;
      }

      // Delegate to Hono for REST routes
      return app.fetch(req);
    },
    websocket: wsHandlers,
  });

  return { server, app, roomManager };
}
