import { Database } from "bun:sqlite";
import type { Message, Sender } from "@agentmeets/shared";

export function saveMessage(
  db: Database,
  roomId: string,
  sender: Sender,
  content: string,
): Message {
  const stmt = db.prepare(
    `INSERT INTO messages (room_id, sender, content) VALUES (?, ?, ?) RETURNING *`,
  );
  return stmt.get(roomId, sender, content) as Message;
}

export function getMessages(db: Database, roomId: string): Message[] {
  const stmt = db.prepare(
    `SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC, id ASC`,
  );
  return stmt.all(roomId) as Message[];
}

export function getPendingMessages(
  db: Database,
  roomId: string,
): Message[] {
  const stmt = db.prepare(
    `SELECT m.* FROM messages m
     JOIN rooms r ON m.room_id = r.id
     WHERE m.room_id = ?
       AND m.sender = 'host'
       AND (r.joined_at IS NULL OR m.created_at < r.joined_at)
     ORDER BY m.created_at ASC, m.id ASC`,
  );
  return stmt.all(roomId) as Message[];
}
