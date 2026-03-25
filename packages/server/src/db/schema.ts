import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  host_token  TEXT NOT NULL,
  guest_token TEXT,
  status      TEXT NOT NULL DEFAULT 'waiting',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  joined_at   TEXT,
  closed_at   TEXT,
  close_reason TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  sender     TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);
`;

export function initializeSchema(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
}
