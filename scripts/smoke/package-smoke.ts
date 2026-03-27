import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function main() {
  const packDir = await mkdtemp(join(tmpdir(), "agentmeets-package-pack-"));
  const installDir = await mkdtemp(join(tmpdir(), "agentmeets-package-install-"));

  await $`bun run build`.cwd(join(ROOT, "packages/mcp-server"));
  await $`bun run build`.cwd(join(ROOT, "packages/session-helper"));
  await $`bun run build`.cwd(join(ROOT, "packages/ui"));

  const mcpTgzName = (
    await $`npm pack --silent --ignore-scripts --pack-destination ${packDir} ${join(ROOT, "packages/mcp-server")}`.text()
  ).trim();
  const sessionHelperTgzName = (
    await $`npm pack --silent --ignore-scripts --pack-destination ${packDir} ${join(ROOT, "packages/session-helper")}`.text()
  ).trim();

  const mcpTgz = join(packDir, mcpTgzName);
  const sessionHelperTgz = join(packDir, sessionHelperTgzName);

  await $`npm init -y`.cwd(installDir);
  await $`npm install ${mcpTgz} ${sessionHelperTgz}`.cwd(installDir);
  await $`npx agentmeets-session --help`.cwd(installDir);

  const mcp = Bun.spawn(
    ["node", join(installDir, "node_modules/.bin/agentmeets-mcp")],
    {
      cwd: installDir,
      env: {
        ...process.env,
        AGENTMEETS_URL: "http://127.0.0.1:3100",
      },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  await Bun.sleep(500);
  assert.equal(mcp.exitCode, null, "agentmeets-mcp exited too early");
  mcp.kill();

  console.log("PASS package smoke");
}

await main();
