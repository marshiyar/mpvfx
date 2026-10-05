import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = fileURLToPath(new URL("../../Crosspost/", import.meta.url));
const outputDir = fileURLToPath(new URL("../../studio/.build/Crosspost/", import.meta.url));

export function crosspostBundleName(platform = process.platform) {
  return platform === "win32" ? "mpvfx-publisher.exe" : "mpvfx-publisher";
}

/** Build a self-contained local GUI from audited source; credentials never enter the bundle. */
export function buildCrosspostBundle(options = {}) {
  const source = options.sourceDir ?? sourceDir;
  const output = options.outputDir ?? outputDir;
  const platform = options.platform ?? process.platform;
  const bundle = options.bundle ?? process.env.MPVFX_BUNDLE_CROSSPOST === "1";
  const bin = join(output, "bin");
  // A source-only local build must not accidentally package a stale frozen GUI.
  if (!bundle) {
    rmSync(bin, { recursive: true, force: true });
    return null;
  }
  const python = options.python ?? process.env.MPVFX_PUBLISHER_BUILD_PYTHON ??
    (platform === "win32" ? "python" : "python3");
  const scratch = mkdtempSync(join(tmpdir(), "mpvfx-publisher-build-"));
  try {
    const result = spawnSync(python, [
      "-m", "PyInstaller", "--onefile", "--noconfirm", "--clean",
      ...(platform === "win32" ? ["--windowed"] : []),
      "--name", "mpvfx-publisher", "--collect-all", "customtkinter",
      "--distpath", join(scratch, "dist"), "--workpath", join(scratch, "work"),
      "--specpath", join(scratch, "spec"), join(source, "gui.py"),
    ], {
      cwd: source, encoding: "utf8", stdio: "inherit", timeout: 300_000,
      env: { ...process.env, PYINSTALLER_CONFIG_DIR: join(scratch, "cache") },
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Could not build bundled publisher (${result.error?.message ?? result.status})`);
    }
    const built = join(scratch, "dist", crosspostBundleName(platform));
    if (!existsSync(built) || !statSync(built).isFile()) {
      throw new Error(`Publisher build did not produce ${crosspostBundleName(platform)}`);
    }
    const marker = join(scratch, "preflight-ready");
    const preflight = spawnSync(built, ["--preflight", "--ready-file", marker], {
      cwd: scratch, encoding: "utf8", timeout: 30_000, windowsHide: true,
    });
    if (preflight.error || preflight.status !== 0 ||
        !existsSync(marker) || readFileSync(marker, "utf8") !== "mpvfx-publisher-ready") {
      throw new Error(`Bundled publisher preflight failed: ${preflight.error?.message ?? preflight.stderr?.trim() ?? preflight.status}`);
    }
    rmSync(bin, { recursive: true, force: true });
    mkdirSync(bin, { recursive: true });
    const destination = join(bin, crosspostBundleName(platform));
    copyFileSync(built, destination);
    if (platform !== "win32") chmodSync(destination, 0o755);
    return destination;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildCrosspostBundle();
}
