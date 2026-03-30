import { customAlphabet } from "nanoid";

const roomIdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const generateId = customAlphabet(roomIdAlphabet, 6);

export function generateRoomId(): string {
  return generateId();
}

export function generateToken(): string {
  return crypto.randomUUID();
}
