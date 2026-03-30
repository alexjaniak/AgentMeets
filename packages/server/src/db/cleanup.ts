import type { AgentMeetsStore } from "./store.js";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function sweepExpiredRooms(store: AgentMeetsStore, now: Date = new Date()): Promise<number> {
  return store.sweepExpiredRooms(now);
}

export function startCleanupInterval(store: AgentMeetsStore): Timer {
  void sweepExpiredRooms(store).catch((error) => {
    console.error("Initial cleanup sweep failed", error);
  });
  const timer = setInterval(() => {
    void sweepExpiredRooms(store).catch((error) => {
      console.error("Cleanup sweep failed", error);
    });
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
  return timer;
}
