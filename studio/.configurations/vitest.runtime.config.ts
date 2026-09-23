import { defineConfig, mergeConfig } from "vitest/config";
import config from "./vitest.config";

// A separate process prevents renderer mocks from leaking into the real API.
export default mergeConfig(config, defineConfig({
  test: { include: ["desktop/tests/runtime.integration.test.ts"] },
}));
