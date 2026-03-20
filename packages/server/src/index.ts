import { Hono } from "hono";
import { createDatabase } from "./db/index.js";

const db = createDatabase();

const app = new Hono();

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

export { db };

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
};
