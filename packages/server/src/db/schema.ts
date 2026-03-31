import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  room_stem   TEXT,
  host_token  TEXT NOT NULL,
  guest_token TEXT,
  status      TEXT NOT NULL DEFAULT 'waiting',
  opening_message_id INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
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

CREATE TABLE IF NOT EXISTS invites (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id                TEXT NOT NULL REFERENCES rooms(id),
  participant_role       TEXT NOT NULL DEFAULT 'guest',
  token_hash             TEXT NOT NULL,
  expires_at             TEXT NOT NULL,
  claimed_at             TEXT,
  claim_idempotency_key  TEXT,
  claim_session_token    TEXT,
  claim_guest_token      TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_room_id ON invites(room_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_room_role ON invites(room_id, participant_role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_room_stem ON rooms(room_stem);
`;

export function initializeSchema(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  const roomColumns = db
    .prepare(`PRAGMA table_info(rooms)`)
    .all() as Array<{ name: string }>;
  if (!roomColumns.some((column) => column.name === "opening_message_id")) {
    db.exec(`ALTER TABLE rooms ADD COLUMN opening_message_id INTEGER;`);
  }
  if (!roomColumns.some((column) => column.name === "room_stem")) {
    db.exec(`ALTER TABLE rooms ADD COLUMN room_stem TEXT;`);
  }
  if (!roomColumns.some((column) => column.name === "last_activity_at")) {
    db.exec(`ALTER TABLE rooms ADD COLUMN last_activity_at TEXT DEFAULT (datetime('now'));`);
    db.exec(`UPDATE rooms SET last_activity_at = COALESCE(last_activity_at, created_at, datetime('now'));`);
  }

  const inviteColumns = db
    .prepare(`PRAGMA table_info(invites)`)
    .all() as Array<{ name: string }>;
  if (!inviteColumns.some((column) => column.name === "participant_role")) {
    db.exec(`ALTER TABLE invites ADD COLUMN participant_role TEXT NOT NULL DEFAULT 'guest';`);
  }
  if (!inviteColumns.some((column) => column.name === "claim_session_token")) {
    db.exec(`ALTER TABLE invites ADD COLUMN claim_session_token TEXT;`);
    db.exec(`UPDATE invites SET claim_session_token = COALESCE(claim_guest_token, claim_session_token);`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_room_role ON invites(room_id, participant_role);`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_room_stem ON rooms(room_stem);`);
}
