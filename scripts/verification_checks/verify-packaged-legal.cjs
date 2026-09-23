const { existsSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const REQUIRED_LEGAL_FILES = new Map([
  ["NOTICES/NOTICE.txt", "Additional runtime dependency notices"],
  ["PRIVACY.md", "# Privacy"],
  ["NOTICES/REMOTE_ASSETS.md", "Remote asset provenance"],
  ["NOTICES/FFMPEG_SOURCE.md", "FFmpeg and FFprobe distribution record"],
  ["NOTICES/THIRD_PARTY_NOTICES.md", "Binary distribution"],
  ["NOTICES/Apache-2.0.txt", "Apache License"],
  ["NOTICES/GPL-3.0.txt", "GNU GENERAL PUBLIC LICENSE"],
  ["NOTICES/GSAP-NOTICE.txt", "GSAP 3.15.0"],
]);

function packagedLegalDirectory(outputPath, platform) {
  const resources =
    platform === "darwin"
      ? join(
          outputPath.endsWith(".app") ? outputPath : join(outputPath, "MpVFX.app"),
          "Contents",
          "Resources",
        )
      : join(outputPath, "resources");
  return join(resources, "legal");
}

function assertPackagedLegalResources(packageResult) {
  for (const outputPath of packageResult.outputPaths) {
    const legalDirectory = packagedLegalDirectory(outputPath, packageResult.platform);
    for (const [name, marker] of REQUIRED_LEGAL_FILES) {
      const path = join(legalDirectory, name);
      if (!existsSync(path) || !statSync(path).isFile()) {
        throw new Error(`Packaged legal resource is missing at "${path}"`);
      }
      if (!readFileSync(path, "utf8").includes(marker)) {
        throw new Error(`Packaged legal resource is invalid or empty at "${path}"`);
      }
    }
  }
}

module.exports = {
  assertPackagedLegalResources,
  packagedLegalDirectory,
};
