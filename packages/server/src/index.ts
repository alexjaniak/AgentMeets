import { Hono } from "hono";
import { createDatabase } from "./db/index.js";
import { RoomManager, createWebSocketHandlers, handleUpgrade } from "./ws/index.js";
import type { WsData } from "./ws/index.js";
import { inviteRoutes } from "./routes/invites.js";
import { publicRoomRoutes } from "./routes/public-rooms.js";
import { roomRoutes } from "./routes/rooms.js";
import { corsMiddleware } from "./middleware/cors.js";
import { requestLogger } from "./middleware/logger.js";

export function createServer(port = 3000) {
  const db = createDatabase(process.env.DATABASE_PATH);
  const app = new Hono();
  app.use("*", corsMiddleware());
  app.use("*", requestLogger());
  const roomManager = new RoomManager(db);
  const wsHandlers = createWebSocketHandlers(roomManager);

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/", roomRoutes(db));
  app.route("/", inviteRoutes(db));
  app.route("/", publicRoomRoutes(db));

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
const { server, roomManager } = createServer(port);
console.log(`AgentMeets server listening on port ${server.port}`);

function shutdown() {
  console.log("Shutting down...");
  roomManager.shutdown();
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
