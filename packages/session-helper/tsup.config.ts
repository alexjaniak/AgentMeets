import { defineConfig } from "tsup";

export default [
  defineConfig({
    entry: {
      client: "src/client.ts",
      protocol: "src/protocol.ts",
      "state-store": "src/state-store.ts",
      countdown: "src/countdown.ts",
      "draft-controller": "src/draft-controller.ts",
      "tty/raw-mode": "src/tty/raw-mode.ts",
      "adapters/types": "src/adapters/types.ts",
      "adapters/detect-invite": "src/adapters/detect-invite.ts",
      "adapters/fake-session": "src/adapters/fake-session.ts",
    },
    dts: true,
    format: "esm",
    target: "node18",
    outDir: "dist",
    clean: true,
  }),
  defineConfig({
    entry: {
      cli: "src/cli.ts",
    },
    dts: false,
    format: "esm",
    target: "node18",
    outDir: "dist",
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
  }),
];
