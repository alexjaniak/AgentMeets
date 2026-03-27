import { Database } from "bun:sqlite";
import type { StoredRoom, StoredCloseReason, Sender } from "@agentmeets/shared";

export function createRoom(
  db: Database,
  id: string,
  hostToken: string,
  openingMessage?: string,
  roomStem?: string,
): StoredRoom {
  if (!openingMessage) {
    if (roomStem) {
      const stmt = db.prepare(
        `INSERT INTO rooms (id, room_stem, host_token, status)
         VALUES (?, ?, ?, 'waiting')
         RETURNING *`,
      );
      return stmt.get(id, roomStem, hostToken) as StoredRoom;
    }

    const stmt = db.prepare(
      `INSERT INTO rooms (id, host_token, status) VALUES (?, ?, 'waiting') RETURNING *`,
    );
    return stmt.get(id, hostToken) as StoredRoom;
  }

  const insertRoom = roomStem
    ? db.prepare(
        `INSERT INTO rooms (id, room_stem, host_token, status)
         VALUES (?, ?, ?, 'waiting')`,
      )
    : db.prepare(`INSERT INTO rooms (id, host_token, status) VALUES (?, ?, 'waiting')`);
  const insertOpeningMessage = db.prepare(
    `INSERT INTO messages (room_id, sender, content) VALUES (?, 'host', ?) RETURNING id`,
  );
  const linkOpeningMessage = db.prepare(
    `UPDATE rooms SET opening_message_id = ? WHERE id = ?`,
  );
  const selectRoom = db.prepare(`SELECT * FROM rooms WHERE id = ?`);

  return db.transaction(() => {
    if (roomStem) {
      insertRoom.run(id, roomStem, hostToken);
    } else {
      insertRoom.run(id, hostToken);
    }
    const message = insertOpeningMessage.get(id, openingMessage) as { id: number };
    linkOpeningMessage.run(message.id, id);
    return selectRoom.get(id) as StoredRoom;
  })();
}

export function getRoom(db: Database, id: string): StoredRoom | null {
  const stmt = db.prepare(`SELECT * FROM rooms WHERE id = ?`);
  return (stmt.get(id) as StoredRoom) ?? null;
}

export function joinRoom(
  db: Database,
  id: string,
  guestToken: string,
): StoredRoom {
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
    `UPDATE rooms
     SET guest_token = ?,
         status = 'active',
         joined_at = datetime('now'),
         last_activity_at = ?
     WHERE id = ?
     RETURNING *`,
  );
  return stmt.get(guestToken, new Date().toISOString(), id) as StoredRoom;
}

export function activateRoom(db: Database, id: string): StoredRoom {
  const room = getRoom(db, id);
  if (!room) {
    throw new Error("Room not found");
  }
  if (room.status === "expired" || room.status === "closed") {
    throw new Error(`Room is ${room.status}`);
  }
  if (room.status === "active") {
    return room;
  }
  if (room.guest_token === null) {
    throw new Error("Room has no guest");
  }

  const stmt = db.prepare(
    `UPDATE rooms
     SET status = 'active',
         joined_at = COALESCE(joined_at, datetime('now'))
     WHERE id = ?
     RETURNING *`,
  );
  return stmt.get(id) as StoredRoom;
}

export function touchRoomActivity(db: Database, id: string): void {
  db.prepare(`UPDATE rooms SET last_activity_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id,
  );
}

export function closeRoom(
  db: Database,
  id: string,
  reason: StoredCloseReason,
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
): { room: StoredRoom; role: Sender } | null {
  const stmt = db.prepare(
    `SELECT * FROM rooms WHERE host_token = ? OR guest_token = ?`,
  );
  const room = stmt.get(token, token) as StoredRoom | undefined;
  if (!room) return null;

  const role: Sender = room.host_token === token ? "host" : "guest";
  return { room, role };
}
