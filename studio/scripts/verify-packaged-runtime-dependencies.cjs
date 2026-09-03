const {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readSync,
  statSync,
} = require("node:fs");
const { join } = require("node:path");
const { listPackage } = require("@electron/asar");
const {
  assertExecutableBufferMatchesTarget,
} = require("./verify-packaged-media-binaries.cjs");

function packagedResourcesPath(outputPath, platform) {
  if (platform === "darwin") {
    const appPath = outputPath.endsWith(".app")
      ? outputPath
      : join(outputPath, "MpVFX.app");
    return join(appPath, "Contents", "Resources");
  }
  return join(outputPath, "resources");
}

function packagedEsbuildPaths(outputPath, platform, arch) {
  const resources = packagedResourcesPath(outputPath, platform);
  const platformPackage = `${platform}-${arch}`;
  const executable = platform === "win32" ? "esbuild.exe" : join("bin", "esbuild");
  return {
    archive: join(resources, "app.asar"),
    packageEntry: "node_modules/esbuild/package.json",
    jsEntry: "node_modules/esbuild/lib/main.js",
    binary: join(
      resources,
      "app.asar.unpacked",
      "node_modules",
      "@esbuild",
      platformPackage,
      executable,
    ),
  };
}

function readExecutableHeader(path) {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(64 * 1024);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function assertPackagedRuntimeDependencies(packageResult) {
  for (const outputPath of packageResult.outputPaths) {
    const paths = packagedEsbuildPaths(
      outputPath,
      packageResult.platform,
      packageResult.arch,
    );
    if (!existsSync(paths.archive) || !statSync(paths.archive).isFile()) {
      throw new Error(`Packaged application archive is missing at "${paths.archive}"`);
    }

    const entries = new Set(listPackage(paths.archive).map((entry) => entry.replace(/^\//, "")));
    for (const entry of [paths.packageEntry, paths.jsEntry]) {
      if (!entries.has(entry)) {
        throw new Error(
          `Packaged top-level esbuild module is missing "${entry}"; ` +
            "@hyperframes/producer cannot start without it",
        );
      }
    }

    if (!existsSync(paths.binary) || !statSync(paths.binary).isFile()) {
      throw new Error(`Packaged esbuild executable is missing at "${paths.binary}"`);
    }
    if (packageResult.platform !== "win32") {
      accessSync(paths.binary, constants.X_OK);
    }
    assertExecutableBufferMatchesTarget(
      "esbuild",
      readExecutableHeader(paths.binary),
      packageResult.platform,
      packageResult.arch,
    );
  }
}

module.exports = {
  assertPackagedRuntimeDependencies,
  packagedEsbuildPaths,
};
