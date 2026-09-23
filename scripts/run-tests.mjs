import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { matchesGlob, resolve } from "node:path";
import { createRequire } from "node:module";

const studioRoot = fileURLToPath(new URL("../studio/", import.meta.url));
const require = createRequire(new URL("../studio/package.json", import.meta.url));
const { parseCLI } = await import(require.resolve("vitest/node"));

const runtimeTest = "desktop/tests/runtime.integration.test.ts";

/** Keep the native runtime suite isolated while honoring npm's file filters. */
export function testRuns(args) {
  const { filter, options } = parseCLI(["vitest", "run", ...args]);
  const includesRuntime = (filter.length === 0 || filter.some((value) => runtimeTest.includes(value)))
    && !(options.exclude ?? []).some((pattern) => matchesGlob(runtimeTest, pattern));
  const runs = [["run", ...args, "--config", ".configurations/vitest.config.ts", "--exclude", runtimeTest]];
  if (includesRuntime) {
    runs[0].push("--passWithNoTests");
    runs.push(["run", ...args, "--config", ".configurations/vitest.runtime.config.ts"]);
  }
  return runs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const args of testRuns(process.argv.slice(2))) {
    const result = spawnSync(process.execPath, [resolve(studioRoot, "node_modules/vitest/vitest.mjs"), ...args], {
      cwd: studioRoot,
      stdio: "inherit",
    });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
}
