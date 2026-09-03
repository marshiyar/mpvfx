import { defineConfig } from "vitest/config";

// Keep tests independent from vite.config.ts. Loading the development-server
// plugin just to collect tests needlessly opens filesystem watchers and can hit
// macOS' per-process descriptor limit before a single assertion runs.
export default defineConfig({
  test: {
    exclude: ["data/**", "dist/**", "desktop-dist/**", "out/**", "node_modules/**"],
    setupFiles: ["src/test-setup.ts"],
  },
});
