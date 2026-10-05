// Builds the video-keyframing engine's Node-API module (vkf.node) from the
// engine source and places it at .build/native/vkf/vkf.node, where the
// desktop app, its preload and the tests load it. A separate checkout can
// still be selected with VKF_ENGINE_DIR for engine development.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const studioDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const engineDir = resolve(process.env.VKF_ENGINE_DIR ?? join(studioDir, "../third_party/video-keyframing"));
const outDir = join(studioDir, ".build/native/vkf");
const buildDir = join(outDir, "cmake");
const nodeDir = dirname(process.execPath);
const require = createRequire(join(studioDir, "package.json"));
const electronVersion = process.platform === "win32" ? require("electron/package.json").version : undefined;
const electronHeaders = electronVersion ? join(studioDir, ".build/electron-headers", electronVersion) : undefined;
const electronHook = process.platform === "win32"
  ? resolve(dirname(require.resolve("@electron/node-gyp/bin/node-gyp.js")), "../src/win_delay_load_hook.cc")
  : undefined;
const nodeApiIncludeDir = process.env.NODE_API_INCLUDE_DIR ?? [
  ...(electronHeaders ? [join(electronHeaders, "include/node")] : []),
  resolve(nodeDir, "../include/node"),
  resolve(nodeDir, "include/node"),
].find((path) => existsSync(join(path, "node_api.h")));
const nodeApiLibrary = process.platform === "win32"
  ? process.env.NODE_API_LIBRARY ?? [
    join(electronHeaders, "x64/node.lib"),
    join(nodeDir, "node.lib"),
    resolve(nodeDir, "../node.lib"),
  ].find((path) => existsSync(path))
  : undefined;

if (!existsSync(join(engineDir, "bindings/node/vkf_node.cpp"))) {
  console.error(`video-keyframing engine not found at ${engineDir}. Set VKF_ENGINE_DIR to its checkout.`);
  process.exit(1);
}
if (!nodeApiIncludeDir || !existsSync(join(nodeApiIncludeDir, "node_api.h"))) {
  console.error(`Node-API headers not found near ${process.execPath}. Set NODE_API_INCLUDE_DIR.`);
  process.exit(1);
}
if (process.platform === "win32" && (!nodeApiLibrary || !existsSync(nodeApiLibrary))) {
  console.error("Electron node.lib not found. Run npm run prepare:electron-windows-headers or set NODE_API_LIBRARY.");
  process.exit(1);
}
if (electronHook && !existsSync(electronHook)) throw new Error(`Electron delay-load hook missing: ${electronHook}`);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

mkdirSync(outDir, { recursive: true });
run("cmake", [
  // CMake >= 3.24: rediscover the selected toolchain after Xcode moves or upgrades.
  "--fresh",
  "-S", engineDir,
  "-B", buildDir,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DVKF_BUILD_NODE=ON",
  "-DVKF_BUILD_OFX=OFF",
  "-DVKF_BUILD_TESTS=OFF",
  "-DVKF_BUILD_TOOLS=OFF",
  "-DVKF_ENABLE_METAL=OFF",
  "-DVKF_ENABLE_VULKAN=OFF",
  "-DVKF_WARNINGS_AS_ERRORS=ON",
  // Node-API headers from the Node running this build (ABI-stable across Electron).
  `-DVKF_NODE_API_INCLUDE_DIR=${nodeApiIncludeDir}`,
  ...(nodeApiLibrary ? [`-DVKF_NODE_API_LIBRARY=${nodeApiLibrary}`] : []),
  ...(electronHook ? [`-DVKF_NODE_API_DELAY_LOAD_HOOK=${electronHook}`] : []),
]);
run("cmake", ["--build", buildDir, "--target", "vkf_node", "--config", "Release"]);
const builtModule = join(buildDir, "node", ...(process.platform === "win32" ? ["Release"] : []), "vkf.node");
if (!existsSync(builtModule)) throw new Error(`Built keyframe module missing: ${builtModule}`);
copyFileSync(builtModule, join(outDir, "vkf.node"));
console.log(`video-keyframing engine module: ${join(outDir, "vkf.node")}`);
