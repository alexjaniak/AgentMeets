import { Database } from "bun:sqlite";

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;

  const dbPath = process.env.DATABASE_PATH ?? "./agentmeets.db";
  db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id          TEXT PRIMARY KEY,
      host_token  TEXT NOT NULL,
      guest_token TEXT,
      status      TEXT NOT NULL DEFAULT 'waiting',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      joined_at   TEXT,
      closed_at   TEXT,
      close_reason TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    TEXT NOT NULL REFERENCES rooms(id),
      sender     TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id)
  `);

  return db;
}
