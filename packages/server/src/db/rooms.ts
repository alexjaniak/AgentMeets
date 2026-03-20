import { customAlphabet } from "nanoid";
import { randomBytes } from "crypto";
import { getDb } from "./db";

const generateRoomId = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 6);

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export interface Room {
  id: string;
  host_token: string;
  guest_token: string | null;
  status: string;
  created_at: string;
  joined_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
}

export interface Message {
  id: number;
  room_id: string;
  sender: string;
  content: string;
  created_at: string;
}

export function createRoom(): { id: string; hostToken: string } {
  const db = getDb();
  const id = generateRoomId();
  const hostToken = generateToken();

  db.prepare("INSERT INTO rooms (id, host_token) VALUES (?, ?)").run(
    id,
    hostToken
  );

  return { id, hostToken };
}

export function joinRoom(
  roomId: string
): { guestToken: string } | { error: "not_found" | "room_expired" | "room_full" } {
  const db = getDb();
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as Room | null;

  if (!room) {
    return { error: "not_found" };
  }

  if (room.status === "expired") {
    return { error: "room_expired" };
  }

  if (room.status === "active" || room.status === "closed") {
    return { error: "room_full" };
  }

  const guestToken = generateToken();

  db.prepare(
    "UPDATE rooms SET guest_token = ?, joined_at = datetime('now'), status = 'active' WHERE id = ?"
  ).run(guestToken, roomId);

  return { guestToken };
}

export function closeRoom(roomId: string, reason: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE rooms SET status = 'closed', closed_at = datetime('now'), close_reason = ? WHERE id = ?"
  ).run(reason, roomId);
}

export function expireRoom(roomId: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE rooms SET status = 'expired', closed_at = datetime('now') WHERE id = ?"
  ).run(roomId);
}

export function getRoom(roomId: string): Room | null {
  const db = getDb();
  return db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as Room | null;
}

export function addMessage(
  roomId: string,
  sender: string,
  content: string
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO messages (room_id, sender, content) VALUES (?, ?, ?)"
  ).run(roomId, sender, content);
}

export function getPendingMessages(roomId: string): Message[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT m.* FROM messages m JOIN rooms r ON m.room_id = r.id WHERE m.room_id = ? AND m.created_at <= COALESCE(r.joined_at, datetime('now')) ORDER BY m.id ASC"
    )
    .all(roomId) as Message[];
}
