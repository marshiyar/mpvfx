import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("Electron Windows headers must be prepared on Windows.");
}

const studioDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../studio");
const require = createRequire(join(studioDir, "package.json"));
const version = require("electron/package.json").version;
const nodeGyp = require.resolve("@electron/node-gyp/bin/node-gyp.js");
const devDir = join(studioDir, ".build/electron-headers");
const args = [nodeGyp, "install", `--target=${version}`, "--arch=x64",
  "--dist-url=https://electronjs.org/headers", `--devdir=${devDir}`, "--ensure"];
const result = spawnSync(process.execPath, args, { cwd: studioDir, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const includeDir = join(devDir, version, "include/node");
const importLibrary = join(devDir, version, "x64/node.lib");
const hook = resolve(dirname(nodeGyp), "../src/win_delay_load_hook.cc");
for (const path of [join(includeDir, "node_api.h"), importLibrary, hook]) {
  if (!existsSync(path)) throw new Error(`Electron native build input missing: ${path}`);
}
console.log(`Electron ${version} Windows headers and import library ready.`);
