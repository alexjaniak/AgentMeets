import { Hono } from "hono";
import { createPgPool } from "./db/pg.js";
import { createPostgresAgentMeetsStore } from "./db/pg-store.js";
import { RoomManager, createWebSocketHandlers, handleUpgrade } from "./ws/index.js";
import type { WsData } from "./ws/index.js";
import { inviteRoutes } from "./routes/invites.js";
import { publicRoomRoutes } from "./routes/public-rooms.js";
import { roomRoutes } from "./routes/rooms.js";
import { corsMiddleware } from "./middleware/cors.js";
import { requestLogger } from "./middleware/logger.js";
import { startCleanupInterval } from "./db/cleanup.js";
import { STARTUP_LOG_PREFIX } from "./server-copy.js";

export function createServer(port = 3000) {
  const pool = createPgPool();
  const store = createPostgresAgentMeetsStore({ pool });
  const cleanupTimer = startCleanupInterval(store);
  const app = new Hono();
  app.use("*", corsMiddleware());
  app.use("*", requestLogger());
  const roomManager = new RoomManager(store);
  const wsHandlers = createWebSocketHandlers(roomManager);

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/", roomRoutes(store));
  app.route("/", inviteRoutes(store));
  app.route("/", publicRoomRoutes(store));

  const server = Bun.serve<WsData>({
    port,
    async fetch(req, server) {
      const upgradeResponse = await handleUpgrade(req, server, store, roomManager);
      if (upgradeResponse) return upgradeResponse;

      const url = new URL(req.url);
      if (url.pathname.match(/^\/rooms\/[^/]+\/ws$/)) {
        return undefined as unknown as Response;
      }

      return app.fetch(req);
    },
    websocket: wsHandlers,
  });

  return { server, app, roomManager, store, pool, cleanupTimer };
}

const port = Number(process.env.PORT) || 3000;
const { server, roomManager, pool, cleanupTimer } = createServer(port);
console.log(`${STARTUP_LOG_PREFIX} ${server.port}`);

async function shutdown() {
  console.log("Shutting down...");
  clearInterval(cleanupTimer);
  roomManager.shutdown();
  server.stop();
  await pool.end();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
