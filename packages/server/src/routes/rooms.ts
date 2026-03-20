import { Hono } from "hono";
import { createRoom, joinRoom } from "../db/rooms";

// Simple in-memory rate limiter: max 10 join attempts per IP per minute
const joinAttempts = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = joinAttempts.get(ip);

  if (!entry || now >= entry.resetAt) {
    joinAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }

  entry.count++;
  return entry.count > 10;
}

// Clean up expired rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of joinAttempts) {
    if (now >= entry.resetAt) {
      joinAttempts.delete(ip);
    }
  }
}, 60_000);

const rooms = new Hono();

rooms.post("/", (c) => {
  const room = createRoom();
  return c.json({ roomId: room.id, hostToken: room.hostToken }, 201);
});

rooms.post("/:id/join", (c) => {
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown";

  if (isRateLimited(ip)) {
    return c.json({ error: "rate_limited" }, 429);
  }

  const roomId = c.req.param("id");
  const result = joinRoom(roomId);

  if ("error" in result) {
    switch (result.error) {
      case "not_found":
        return c.json({ error: "not_found" }, 404);
      case "room_expired":
        return c.json({ error: "room_expired" }, 410);
      case "room_full":
        return c.json({ error: "room_full" }, 409);
    }
  }

  return c.json({ guestToken: result.guestToken }, 200);
});

export default rooms;
