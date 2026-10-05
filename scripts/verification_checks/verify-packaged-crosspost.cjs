const { spawnSync } = require("node:child_process");
const { lstatSync } = require("node:fs");
const { join } = require("node:path");

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
    const result = spawnSync(executable, ["--preflight"], {
      cwd: join(executable, "..", ".."), encoding: "utf8", timeout: 45_000, windowsHide: true,
    });
    if (result.error || result.status !== 0 || !result.stdout?.includes("mpvfx-publisher-ready")) {
      throw new Error(`Packaged publisher failed preflight: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
    }
  }
}

module.exports = { assertPackagedCrosspostBundle, packagedPublisherPath };
