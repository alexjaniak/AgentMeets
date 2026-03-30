import { Database } from "bun:sqlite";
import { initializeSchema } from "./schema.js";
export type {
  AgentMeetsStore,
  CreateRoomWithInvitesInput,
  CreateRoomInput,
  InviteClaimResult,
  InviteManifest,
  PublicRoomSnapshot,
  RoomTokenLookup,
  StoredInvite,
} from "./store.js";
export { InviteError } from "./store.js";
export { createFakeAgentMeetsStore } from "./fake-store.js";
export { createPgPool, readDatabaseUrl, withPgTransaction } from "./pg.js";
export { createPostgresAgentMeetsStore } from "./pg-store.js";
export { generateRoomId, generateToken } from "./tokens.js";

export {
  createRoom,
  getRoom,
  joinRoom,
  activateRoom,
  closeRoom,
  expireRoom,
  getRoomByToken,
  markRoleConnected,
  clearRoleConnected,
  touchRoomActivity,
} from "./rooms.js";
export { saveMessage, getMessages, getPendingMessages } from "./messages.js";
export {
  createInvite,
  issueInvite,
  getInviteManifest,
  claimInvite,
} from "./invites.js";

const DEFAULT_DB_PATH = "./agentmeets.db";

export function createDatabase(path: string = DEFAULT_DB_PATH): Database {
  const db = new Database(path);
  initializeSchema(db);
  return db;
}
