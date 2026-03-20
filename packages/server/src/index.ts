import { Hono } from "hono";
import { getDb } from "./db/db";
import rooms from "./routes/rooms";

// Initialize database on startup
getDb();

const app = new Hono();
app.route("/rooms", rooms);

const port = parseInt(process.env.PORT ?? "3000", 10);

export default {
  port,
  fetch: app.fetch.bind(app),
};

console.log(`AgentMeets server running on port ${port}`);
