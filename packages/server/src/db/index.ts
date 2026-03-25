import { Database } from "bun:sqlite";
import { customAlphabet } from "nanoid";
import { initializeSchema } from "./schema.js";

export { createRoom, getRoom, joinRoom, closeRoom, expireRoom, getRoomByToken } from "./rooms.js";
export { saveMessage, getMessages, getPendingMessages } from "./messages.js";

const DEFAULT_DB_PATH = "./agentmeets.db";

export function createDatabase(path: string = DEFAULT_DB_PATH): Database {
  const db = new Database(path);
  initializeSchema(db);
  return db;
}

const roomIdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const generateId = customAlphabet(roomIdAlphabet, 6);

export function generateRoomId(): string {
  return generateId();
}

export function generateToken(): string {
  return crypto.randomUUID();
}
