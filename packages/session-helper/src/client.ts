import {
  createCountdown,
  type CountdownController,
  type CreateCountdownOptions,
} from "./countdown.js";
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
  countdownOptions?: CreateCountdownOptions;
}

export interface SessionHelperClient {
  stateStore: StateStore;
  controller: DraftController;
  getState(): SessionHelperState;
  beginSend(content: string): Promise<SessionMessagePayload>;
  applyCountdownResult(result: CountdownResult): Promise<DraftControllerEvent>;
  processServerMessage(message: SessionServerMessage): Promise<DraftControllerEvent[]>;
  handleKeypress(input: string): Promise<DraftControllerEvent[]>;
  resumeAutoMode(): Promise<DraftControllerEvent[]>;
  waitForIdle(): Promise<void>;
  reload(): Promise<SessionHelperState>;
}

export async function createSessionHelperClient({
  rootDir,
  roomId,
  countdownOptions,
}: CreateSessionHelperClientOptions): Promise<SessionHelperClient> {
  const stateStore = createStateStore({ rootDir, roomId });
  const initialState = await stateStore.load();
  let controller = createDraftController({
    roomId,
    initialState,
  });
  let countdown: CountdownController | null = null;
  let countdownTransition: Promise<DraftControllerEvent[]> = Promise.resolve([]);
  let pendingWork: Promise<void> = Promise.resolve();

  const client: SessionHelperClient = {
    stateStore,
    controller,
    getState() {
      return controller.getSnapshot();
    },
    async beginSend(content) {
      const payload = controller.beginSend(content);
      await schedule(async () => {
        await persist(stateStore, controller);
      });
      return payload;
    },
    async applyCountdownResult(result) {
      cancelCountdown();
      const event = await schedule(async () => {
        const nextEvent = controller.applyCountdownResult(result);
        await persist(stateStore, controller);
        return nextEvent;
      });
      return event;
    },
    async processServerMessage(message) {
      const events = await schedule(async () => {
        const nextEvents = controller.processServerMessage(message);
        await persist(stateStore, controller);
        return nextEvents;
      });
      if (controller.getSnapshot().terminal) {
        cancelCountdown();
      }
      return events;
    },
    async handleKeypress(input) {
      if (!countdown || !countdown.handleKeypress(input)) {
        return [];
      }

      return countdownTransition;
    },
    async resumeAutoMode() {
      const events = await schedule(async () => {
        const nextEvents = controller.resumeAutoMode();
        await persist(stateStore, controller);
        return nextEvents;
      });
      armCountdown();
      return events;
    },
    async waitForIdle() {
      await pendingWork;
      await countdownTransition;
      await pendingWork;
    },
    async reload() {
      cancelCountdown();
      controller = createDraftController({
        roomId,
        initialState: await stateStore.load(),
      });
      client.controller = controller;
      armCountdown();
      return controller.getSnapshot();
    },
  };

  armCountdown();
  return client;

  function schedule<T>(task: () => Promise<T>): Promise<T> {
    const nextTask = pendingWork.then(task, task);
    pendingWork = nextTask.then(
      () => undefined,
      () => undefined,
    );
    return nextTask;
  }

  function cancelCountdown(): void {
    countdown?.cancel();
    countdown = null;
    countdownTransition = Promise.resolve([]);
  }

  function armCountdown(): void {
    cancelCountdown();

    const snapshot = controller.getSnapshot();
    if (snapshot.draftMode !== "auto" || snapshot.terminal) {
      return;
    }

    const currentCountdown = createCountdown(countdownOptions);
    countdown = currentCountdown;
    countdownTransition = currentCountdown.result.then((result) =>
      schedule(async () => {
        if (countdown !== currentCountdown) {
          return [];
        }

        const event = controller.applyCountdownResult(result);
        countdown = null;
        await persist(stateStore, controller);
        return [event];
      }),
    );
  }
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
