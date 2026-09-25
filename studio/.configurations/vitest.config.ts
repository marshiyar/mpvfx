import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import tsconfig from "./tsconfig.json";

// Keep tests independent from vite.config.ts. Loading the development-server
// plugin just to collect tests needlessly opens filesystem watchers and can hit
// macOS' per-process descriptor limit before a single assertion runs.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  esbuild: { tsconfigRaw: JSON.stringify(tsconfig) },
  test: {
    exclude: [".build/**", "data/**", "dist/**", "desktop-dist/**", "out/**", "node_modules/**"],
    env: { VKF_ENGINE_MODULE: fileURLToPath(new URL("../.build/native/vkf/vkf.node", import.meta.url)) },
    setupFiles: [".configurations/vkfEngineTestSetup.ts", "src/test-support/fetchStubTestUtils.ts"],
  },
});
