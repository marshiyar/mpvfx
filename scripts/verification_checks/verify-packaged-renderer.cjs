const { existsSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const FORBIDDEN_RENDERER_MARKERS = [
  "Select off-canvas element",
  "Off-canvas:",
];

function packagedRendererArchivePath(outputPath, platform) {
  if (platform === "darwin") {
    const appPath = outputPath.endsWith(".app")
      ? outputPath
      : join(outputPath, "MpVFX.app");
    return join(appPath, "Contents", "Resources", "app.asar");
  }
  return join(outputPath, "resources", "app.asar");
}

function assertRendererArchiveBuffer(buffer, archivePath) {
  for (const marker of FORBIDDEN_RENDERER_MARKERS) {
    if (buffer.includes(Buffer.from(marker))) {
      throw new Error(
        `Packaged renderer contains the removed off-canvas editor overlay (${JSON.stringify(marker)}) in "${archivePath}"`,
      );
    }
  }
}

function assertPackagedRenderer(packageResult) {
  for (const outputPath of packageResult.outputPaths) {
    const archivePath = packagedRendererArchivePath(outputPath, packageResult.platform);
    if (!existsSync(archivePath) || !statSync(archivePath).isFile()) {
      throw new Error(`Packaged renderer archive is missing at "${archivePath}"`);
    }
    assertRendererArchiveBuffer(readFileSync(archivePath), archivePath);
  }
}

module.exports = {
  assertPackagedRenderer,
  assertRendererArchiveBuffer,
  packagedRendererArchivePath,
};
