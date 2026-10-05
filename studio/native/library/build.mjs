import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const source = dirname(fileURLToPath(import.meta.url));
const studioDir = resolve(source, "../..");
const require = createRequire(join(studioDir, "package.json"));
const output = resolve(source, "../../.build/native/library");
const isWindows = process.platform === "win32";
const vcpkgRoot = process.env.VCPKG_ROOT ?? process.env.VCPKG_INSTALLATION_ROOT;
const toolchain = process.env.CMAKE_TOOLCHAIN_FILE ?? (vcpkgRoot ? join(vcpkgRoot, "scripts/buildsystems/vcpkg.cmake") : undefined);
if (isWindows && !toolchain) {
  throw new Error("Windows library build requires SQLite3. Set VCPKG_ROOT to a vcpkg installation or CMAKE_TOOLCHAIN_FILE to a toolchain that provides SQLite3.");
}
const nodeRoot = dirname(process.execPath);
const electronVersion = isWindows ? require("electron/package.json").version : undefined;
const electronHeaders = electronVersion ? join(studioDir, ".build/electron-headers", electronVersion) : undefined;
const electronHook = isWindows
  ? resolve(dirname(require.resolve("@electron/node-gyp/bin/node-gyp.js")), "../src/win_delay_load_hook.cc")
  : undefined;
const nodeHeaders = process.env.NODE_API_INCLUDE_DIR ?? [
  ...(electronHeaders ? [join(electronHeaders, "include/node")] : []),
  resolve(nodeRoot, "../include/node"),
  resolve(nodeRoot, "include/node"),
].find((path) => existsSync(join(path, "node_api.h")));
const nodeLibrary = isWindows ? process.env.NODE_API_LIBRARY ?? [
  join(electronHeaders, "x64/node.lib"),
  join(nodeRoot, "node.lib"),
  resolve(nodeRoot, "../node.lib"),
].find(existsSync) : undefined;
if (!nodeHeaders || !existsSync(join(nodeHeaders, "node_api.h"))) {
  throw new Error(`Node-API headers not found near ${process.execPath}. Set NODE_API_INCLUDE_DIR.`);
}
if (isWindows && (!nodeLibrary || !existsSync(nodeLibrary))) {
  throw new Error("Electron node.lib not found. Run npm run prepare:electron-windows-headers or set NODE_API_LIBRARY.");
}
if (electronHook && !existsSync(electronHook)) throw new Error(`Electron delay-load hook missing: ${electronHook}`);
for (const args of [
  [
    // CMake >= 3.24: also refresh cached SDK-dependent library paths.
    "--fresh",
    "-S",
    source,
    "-B",
    output,
    "-DCMAKE_BUILD_TYPE=Release",
    ...(process.platform === "darwin"
      ? [
          "-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0",
          `-DCMAKE_OSX_ARCHITECTURES=${process.arch === "arm64" ? "arm64" : "x86_64"}`,
        ]
      : []),
    ...(toolchain ? [`-DCMAKE_TOOLCHAIN_FILE=${resolve(toolchain)}`] : []),
    ...(isWindows ? ["-DVCPKG_TARGET_TRIPLET=x64-windows-static-md", `-DNODE_API_LIBRARY=${resolve(nodeLibrary)}`, `-DNODE_API_DELAY_LOAD_HOOK=${electronHook}`] : []),
    `-DNODE_API_INCLUDE_DIR=${nodeHeaders}`,
  ],
  ["--build", output, "--config", "Release"],
]) {
  const result = spawnSync("cmake", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
