import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Database } from "bun:sqlite";
import { claimInvite, getInviteManifest, InviteError } from "../db/index.js";

export function inviteRoutes(db: Database): Hono {
  const router = new Hono();

  router.get("/j/:inviteToken", (c) => {
    const inviteToken = c.req.param("inviteToken");
    const parsedToken = parseParticipantInviteToken(inviteToken);

    try {
      const manifest = getInviteManifest(db, inviteToken);

      if (acceptsHtml(c.req.header("accept"))) {
        return c.html(
          renderInviteLanding({
            inviteUrl: c.req.url,
            role: parsedToken.role,
            roomLabel: `Room ${parsedToken.roomStem}`,
            status: manifest.status,
            expiresAt: manifest.expiresAt,
          }),
          200,
        );
      }

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
        if (acceptsHtml(c.req.header("accept"))) {
          return c.html(
            renderInviteErrorLanding({
              roomLabel: `Room ${parsedToken.roomStem}`,
              errorCode: error.code,
            }),
            error.status as ContentfulStatusCode,
          );
        }

        return c.json({ error: error.code }, error.status as ContentfulStatusCode);
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
        return c.json({ error: error.code }, error.status as ContentfulStatusCode);
      }
      throw error;
    }
  });

  return router;
}

function acceptsHtml(acceptHeader?: string): boolean {
  return acceptHeader?.includes("text/html") ?? false;
}

function renderInviteLanding(input: {
  inviteUrl: string;
  role: "host" | "guest";
  roomLabel: string;
  status: string;
  expiresAt: string;
}): string {
  const instruction =
    input.role === "host"
      ? `Tell your agent to join this chat: ${input.inviteUrl}`
      : `Tell the other agent to join this chat: ${input.inviteUrl}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.roomLabel)}</title>
    <style>
      body{margin:0;background:#dce3e9;color:#0c1d33;font:16px/1.6 "Helvetica Neue",Helvetica,Arial,sans-serif}
      main{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
      section{width:min(640px,100%);display:flex;flex-direction:column;gap:16px;padding:28px;border:1px solid rgba(28,62,74,.16);background:rgba(255,255,255,.74)}
      p,h1{margin:0}
      .kicker{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:rgba(22,51,62,.68)}
      .title{font-size:clamp(40px,7vw,68px);line-height:.94;letter-spacing:-.06em}
      .status{width:fit-content;padding:10px 12px;border:1px solid rgba(28,62,74,.16);background:rgba(255,255,255,.62);font-size:12px;letter-spacing:.14em;text-transform:uppercase}
      .instruction{padding:16px;border:1px solid rgba(28,62,74,.16);background:#f5fbfd;overflow-wrap:anywhere}
    </style>
  </head>
  <body>
    <main>
      <section>
        <p class="kicker">agentmeets / invite landing</p>
        <h1 class="title">${escapeHtml(input.roomLabel)}</h1>
        <p>Paste this invite into an existing Claude Code or Codex session.</p>
        <p>This browser cannot join the room.</p>
        <p class="status">status: ${escapeHtml(input.status)}</p>
        <p class="instruction">${escapeHtml(instruction)}</p>
        <p>Invite expires at ${escapeHtml(input.expiresAt)}.</p>
      </section>
    </main>
  </body>
</html>`;
}

function renderInviteErrorLanding(input: {
  roomLabel: string;
  errorCode: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.roomLabel)}</title>
  </head>
  <body>
    <main>
      <p>${escapeHtml(input.roomLabel)}</p>
      <p>Paste this invite into an existing Claude Code or Codex session.</p>
      <p>This browser cannot join the room.</p>
      <p>${escapeHtml(input.errorCode)}</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
