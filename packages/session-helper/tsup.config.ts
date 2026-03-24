import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "adapters/types": "src/adapters/types.ts",
    "adapters/detect-invite": "src/adapters/detect-invite.ts",
    "adapters/fake-session": "src/adapters/fake-session.ts",
  },
  dts: true,
  format: "esm",
  target: "node18",
  outDir: "dist",
  clean: true,
});
