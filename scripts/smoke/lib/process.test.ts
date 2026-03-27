import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  createSmokeDir,
  startManagedProcess,
  waitForHttpReady,
} from "./process";

test("waitForHttpReady resolves when a server becomes reachable", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("ok"),
  });

  await waitForHttpReady(`http://127.0.0.1:${server.port}/health`, 2_000);
  server.stop(true);
});

test("createSmokeDir creates a temp directory with the requested prefix", async () => {
  const dir = await createSmokeDir("agentmeets-smoke-test");
  const dirStat = await stat(dir);

  expect(dirStat.isDirectory()).toBe(true);
  expect(basename(dir)).toStartWith("agentmeets-smoke-test-");
});

test("startManagedProcess stops a spawned process cleanly", async () => {
  const managed = startManagedProcess(
    "sleeper",
    ["bun", "-e", "setInterval(() => {}, 1000)"],
    process.cwd(),
    {},
  );

  await Bun.sleep(50);
  await managed.stop();
});
