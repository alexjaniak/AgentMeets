import {
  createDraftController,
  type CreateDraftControllerOptions,
  type DraftController,
} from "./draft-controller.js";
import {
  createStateStore,
  type CreateStateStoreOptions,
  type StateStore,
} from "./state-store.js";
import type {
  CountdownResult,
  DraftControllerEvent,
  SessionHelperState,
  SessionMessagePayload,
  SessionServerMessage,
} from "./protocol.js";

export interface CreateSessionHelperClientOptions {
  rootDir: string;
  roomId: string;
}

export interface SessionHelperClient {
  stateStore: StateStore;
  controller: DraftController;
  getState(): SessionHelperState;
  beginSend(content: string): Promise<SessionMessagePayload>;
  applyCountdownResult(result: CountdownResult): Promise<DraftControllerEvent>;
  processServerMessage(message: SessionServerMessage): Promise<DraftControllerEvent[]>;
  reload(): Promise<SessionHelperState>;
}

export async function createSessionHelperClient({
  rootDir,
  roomId,
}: CreateSessionHelperClientOptions): Promise<SessionHelperClient> {
  const stateStore = createStateStore({ rootDir, roomId });
  const initialState = await stateStore.load();
  let controller = createDraftController({
    roomId,
    initialState,
  });

  const client: SessionHelperClient = {
    stateStore,
    controller,
    getState() {
      return controller.getSnapshot();
    },
    async beginSend(content) {
      const payload = controller.beginSend(content);
      await persist(stateStore, controller);
      return payload;
    },
    async applyCountdownResult(result) {
      const event = controller.applyCountdownResult(result);
      await persist(stateStore, controller);
      return event;
    },
    async processServerMessage(message) {
      const events = controller.processServerMessage(message);
      await persist(stateStore, controller);
      return events;
    },
    async reload() {
      controller = createDraftController({
        roomId,
        initialState: await stateStore.load(),
      });
      client.controller = controller;
      return controller.getSnapshot();
    },
  };

  return client;
}

async function persist(
  stateStore: StateStore,
  controller: DraftController,
): Promise<void> {
  await stateStore.save(controller.getSnapshot());
}

export type {
  CreateDraftControllerOptions,
  CreateStateStoreOptions,
  DraftController,
  StateStore,
};
