import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cloneSessionHelperState,
  createInitialSessionHelperState,
  type SessionHelperState,
  type SessionMessageEvent,
  type TerminalState,
} from "./protocol.js";

export interface CreateStateStoreOptions {
  rootDir: string;
  roomId: string;
}

export interface StateStore {
  filePath: string;
  load(): Promise<SessionHelperState>;
  save(state: SessionHelperState): Promise<SessionHelperState>;
  patch(
    update:
      | Partial<SessionHelperState>
      | ((current: SessionHelperState) => SessionHelperState),
  ): Promise<SessionHelperState>;
}

export function createStateStore({
  rootDir,
  roomId,
}: CreateStateStoreOptions): StateStore {
  const filePath = join(
    rootDir,
    ".context",
    "agentmeets",
    roomId,
    "state.json",
  );

  return {
    filePath,
    async load() {
      try {
        const raw = await readFile(filePath, "utf8");
        return normalizeState(roomId, JSON.parse(raw));
      } catch (error) {
        if (isMissingFileError(error)) {
          return createInitialSessionHelperState(roomId);
        }

        throw error;
      }
    },
    async save(state) {
      const normalized = normalizeState(roomId, state);
      await mkdir(join(rootDir, ".context", "agentmeets", roomId), {
        recursive: true,
      });
      await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
      return cloneSessionHelperState(normalized);
    },
    async patch(update) {
      const current = await this.load();
      const next =
        typeof update === "function"
          ? update(current)
          : {
              ...current,
              ...update,
            };

      return this.save(next);
    },
  };
}

function normalizeState(
  roomId: string,
  input: unknown,
): SessionHelperState {
  const base = createInitialSessionHelperState(roomId);

  if (!isRecord(input)) {
    return base;
  }

  return {
    roomId:
      typeof input.roomId === "string" && input.roomId.length > 0
        ? input.roomId
        : roomId,
    draftMode: input.draftMode === "manual" ? "manual" : "auto",
    lastReceivedMessageId:
      typeof input.lastReceivedMessageId === "number"
        ? input.lastReceivedMessageId
        : null,
    lastAckedMessageId:
      typeof input.lastAckedMessageId === "number"
        ? input.lastAckedMessageId
        : null,
    pendingClientMessageId:
      typeof input.pendingClientMessageId === "string"
        ? input.pendingClientMessageId
        : null,
    queuedInbound: Array.isArray(input.queuedInbound)
      ? input.queuedInbound
          .map(normalizeQueuedInbound)
          .filter((message): message is SessionMessageEvent => message !== null)
      : [],
    terminal: normalizeTerminalState(input.terminal),
  };
}

function normalizeQueuedInbound(input: unknown): SessionMessageEvent | null {
  if (!isRecord(input)) {
    return null;
  }

  if (
    input.type !== "message" ||
    typeof input.messageId !== "number" ||
    (input.sender !== "host" && input.sender !== "guest") ||
    typeof input.clientMessageId !== "string" ||
    !(typeof input.replyToMessageId === "number" || input.replyToMessageId === null) ||
    typeof input.content !== "string" ||
    typeof input.createdAt !== "string"
  ) {
    return null;
  }

  return {
    type: "message",
    messageId: input.messageId,
    sender: input.sender,
    clientMessageId: input.clientMessageId,
    replyToMessageId: input.replyToMessageId,
    content: input.content,
    createdAt: input.createdAt,
  };
}

function normalizeTerminalState(input: unknown): TerminalState | null {
  if (!isRecord(input) || typeof input.kind !== "string") {
    return null;
  }

  if (
    input.kind === "error" &&
    (input.code === "invalid_json" ||
      input.code === "unknown_message_type" ||
      input.code === "invalid_message") &&
    typeof input.message === "string"
  ) {
    return {
      kind: "error",
      code: input.code,
      message: input.message,
    };
  }

  if (
    input.kind === "ended" &&
    (input.reason === "user_ended" ||
      input.reason === "disconnected" ||
      input.reason === "timeout" ||
      input.reason === "expired" ||
      input.reason === "join_failed")
  ) {
    return {
      kind: "ended",
      reason: input.reason,
    };
  }

  return null;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

