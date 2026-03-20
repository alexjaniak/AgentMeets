import { Hono } from "hono";
import { createDatabase } from "./db/index.js";
import { RoomManager, createWebSocketHandlers, handleUpgrade } from "./ws/index.js";
import type { WsData } from "./ws/index.js";

export function createServer(port = 3000) {
  const db = createDatabase();
  const app = new Hono();
  const roomManager = new RoomManager(db);
  const wsHandlers = createWebSocketHandlers(roomManager);

  app.get("/health", (c) => c.json({ status: "ok" }));

  const server = Bun.serve<WsData>({
    port,
    fetch(req, server) {
      const upgradeResponse = handleUpgrade(req, server, db, roomManager);
      if (upgradeResponse) return upgradeResponse;

      const url = new URL(req.url);
      if (url.pathname.match(/^\/rooms\/[^/]+\/ws$/)) {
        return undefined as unknown as Response;
      }

      return app.fetch(req);
    },
    websocket: wsHandlers,
  });

  return { server, app, roomManager, db };
}

const port = Number(process.env.PORT) || 3000;
const { server } = createServer(port);
console.log(`AgentMeets server listening on port ${server.port}`);
