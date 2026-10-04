// Builds the video-keyframing engine's Node-API module (vkf.node) from the
// engine repository and places it at .build/native/vkf/vkf.node, where the
// desktop app, its preload and the tests load it. The engine is a separate
// project: set VKF_ENGINE_DIR to its checkout (default: a sibling
// "video-keyframing" directory next to this repository's parent).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const studioDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const engineDir = resolve(process.env.VKF_ENGINE_DIR ?? join(studioDir, "../../../video-keyframing"));
const outDir = join(studioDir, ".build/native/vkf");
const buildDir = join(outDir, "cmake");

if (!existsSync(join(engineDir, "bindings/node/vkf_node.cpp"))) {
  console.error(`video-keyframing engine not found at ${engineDir}. Set VKF_ENGINE_DIR to its checkout.`);
  process.exit(1);
}

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
  `-DVKF_NODE_API_INCLUDE_DIR=${resolve(dirname(process.execPath), "../include/node")}`,
]);
run("cmake", ["--build", buildDir, "--target", "vkf_node", "--config", "Release"]);
copyFileSync(join(buildDir, "node/vkf.node"), join(outDir, "vkf.node"));
console.log(`video-keyframing engine module: ${join(outDir, "vkf.node")}`);
