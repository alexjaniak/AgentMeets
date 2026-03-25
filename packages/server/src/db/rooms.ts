import { Database } from "bun:sqlite";
import type { Room, CloseReason, Sender } from "@agentmeets/shared";

export function createRoom(
  db: Database,
  id: string,
  hostToken: string,
): Room {
  const stmt = db.prepare(
    `INSERT INTO rooms (id, host_token, status) VALUES (?, ?, 'waiting') RETURNING *`,
  );
  return stmt.get(id, hostToken) as Room;
}

export function getRoom(db: Database, id: string): Room | null {
  const stmt = db.prepare(`SELECT * FROM rooms WHERE id = ?`);
  return (stmt.get(id) as Room) ?? null;
}

export function joinRoom(
  db: Database,
  id: string,
  guestToken: string,
): Room {
  const room = getRoom(db, id);
  if (!room) {
    throw new Error("Room not found");
  }
  if (room.status === "expired" || room.status === "closed") {
    throw new Error(`Room is ${room.status}`);
  }
  if (room.guest_token !== null) {
    throw new Error("Room is full");
  }

  const stmt = db.prepare(
    `UPDATE rooms SET guest_token = ?, status = 'active', joined_at = datetime('now') WHERE id = ? RETURNING *`,
  );
  return stmt.get(guestToken, id) as Room;
}

export function closeRoom(
  db: Database,
  id: string,
  reason: CloseReason,
): void {
  const stmt = db.prepare(
    `UPDATE rooms SET status = 'closed', closed_at = datetime('now'), close_reason = ? WHERE id = ?`,
  );
  stmt.run(reason, id);
}

export function expireRoom(db: Database, id: string): void {
  const stmt = db.prepare(
    `UPDATE rooms SET status = 'expired', closed_at = datetime('now') WHERE id = ?`,
  );
  stmt.run(id);
}

export function getRoomByToken(
  db: Database,
  token: string,
): { room: Room; role: Sender } | null {
  const stmt = db.prepare(
    `SELECT * FROM rooms WHERE host_token = ? OR guest_token = ?`,
  );
  const room = stmt.get(token, token) as Room | undefined;
  if (!room) return null;

  const role: Sender = room.host_token === token ? "host" : "guest";
  return { room, role };
}
