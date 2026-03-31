import { Database } from "bun:sqlite";
import type { Message, Sender } from "@agentmeets/shared";
import { touchRoomActivity } from "./rooms.js";

export function saveMessage(
  db: Database,
  roomId: string,
  sender: Sender,
  content: string,
): Message {
  const insertMessage = db.prepare(
    `INSERT INTO messages (room_id, sender, content) VALUES (?, ?, ?) RETURNING *`,
  );

  return db.transaction(() => {
    const message = insertMessage.get(roomId, sender, content) as Message;
    touchRoomActivity(db, roomId);
    return message;
  })();
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

export function getOpeningMessage(
  db: Database,
  roomId: string,
): Message | null {
  const stmt = db.prepare(
    `SELECT m.*
     FROM rooms r
     JOIN messages m ON m.id = r.opening_message_id
     WHERE r.id = ?`,
  );
  return (stmt.get(roomId) as Message | undefined) ?? null;
}
