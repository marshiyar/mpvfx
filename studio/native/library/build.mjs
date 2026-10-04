import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const source = dirname(fileURLToPath(import.meta.url));
const output = resolve(source, "../../.build/native/library");
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
    `-DNODE_API_INCLUDE_DIR=${resolve(process.env.NODE_API_INCLUDE_DIR ?? resolve(dirname(process.execPath), "../include/node"))}`,
  ],
  ["--build", output, "--config", "Release"],
]) {
  const result = spawnSync("cmake", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
