import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { claimInvite, getInviteManifest, InviteError } from "../db/index.js";

export function inviteRoutes(db: Database): Hono {
  const router = new Hono();

  router.get("/j/:inviteToken", (c) => {
    try {
      const inviteToken = c.req.param("inviteToken");
      const manifest = getInviteManifest(db, inviteToken);
      const parsedToken = parseParticipantInviteToken(inviteToken);

      return c.json(
        {
          roomId: manifest.roomId,
          roomStem: parsedToken.roomStem,
          role: parsedToken.role,
          status: manifest.status,
          openingMessage: manifest.openingMessage,
          expiresAt: manifest.expiresAt,
        },
        200,
      );
    } catch (error) {
      if (error instanceof InviteError) {
        return c.json({ error: error.code }, error.status);
      }
      throw error;
    }
  });

  router.post("/invites/:inviteToken/claim", (c) => {
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
    if (!idempotencyKey) {
      return c.json({ error: "missing_idempotency_key" }, 400);
    }

    try {
      const result = claimInvite(db, c.req.param("inviteToken"), idempotencyKey);
      return c.json(
        {
          roomId: result.roomId,
          role: result.role,
          sessionToken: result.sessionToken,
          status: result.status,
        },
        200,
      );
    } catch (error) {
      if (error instanceof InviteError) {
        return c.json({ error: error.code }, error.status);
      }
      throw error;
    }
  });

  return router;
}

function parseParticipantInviteToken(
  inviteToken: string,
): { roomStem: string; role: "host" | "guest" } {
  const match = inviteToken.match(/^(r_[A-Za-z0-9_-]+)\.(1|2)$/);
  if (match) {
    return {
      roomStem: match[1],
      role: match[2] === "1" ? "host" : "guest",
    };
  }

  return {
    roomStem: inviteToken,
    role: "guest",
  };
}
