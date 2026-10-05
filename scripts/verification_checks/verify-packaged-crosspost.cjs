const { spawnSync } = require("node:child_process");
const { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

function packagedPublisherPath(outputPath, platform) {
  const resources = platform === "darwin"
    ? join(outputPath.endsWith(".app") ? outputPath : join(outputPath, "MpVFX.app"), "Contents", "Resources")
    : join(outputPath, "resources");
  return join(resources, "Crosspost", "bin", platform === "win32" ? "mpvfx-publisher.exe" : "mpvfx-publisher");
}

function assertPackagedCrosspostBundle(packageResult) {
  if (process.env.MPVFX_BUNDLE_CROSSPOST !== "1") return;
  for (const outputPath of packageResult.outputPaths) {
    const executable = packagedPublisherPath(outputPath, packageResult.platform);
    let info;
    try { info = lstatSync(executable); }
    catch { throw new Error(`Packaged publisher is missing: ${executable}`); }
    if (!info.isFile()) throw new Error(`Packaged publisher is not a regular file: ${executable}`);
    const scratch = mkdtempSync(join(tmpdir(), "mpvfx-packaged-publisher-"));
    try {
      const marker = join(scratch, "ready");
      const result = spawnSync(executable, ["--preflight", "--ready-file", marker], {
        cwd: scratch, encoding: "utf8", timeout: 45_000, windowsHide: true,
      });
      if (result.error || result.status !== 0 ||
          !existsSync(marker) || readFileSync(marker, "utf8") !== "mpvfx-publisher-ready") {
        throw new Error(`Packaged publisher failed preflight: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

module.exports = { assertPackagedCrosspostBundle, packagedPublisherPath };
