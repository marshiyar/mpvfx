// Run the pinned v0.0.7 app and the candidate app on the same CI runner.
// A missing executable, screenshot, or comparison is a failed acceptance run.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { comparePackagedUi } from "./packaged-ui-diff.mjs";

const studio = resolve(import.meta.dirname, "../..");
const repo = resolve(studio, "..");
const baselineRoot = process.env.MPVFX_BASELINE_ROOT;
if (!baselineRoot) throw new Error("MPVFX_BASELINE_ROOT must point to the checked-out v0.0.7 tree");
const baselineSha = execFileSync("git", ["-C", baselineRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (baselineSha !== "fbde94a88cdb022c71d9349b86a6692244d50007")
  throw new Error(`Baseline is not the pinned v0.0.7 commit: ${baselineSha}`);
const evidenceDir = resolve(process.env.MPVFX_UI_EVIDENCE_DIR ?? join(studio, ".build/ui-evidence"));
await mkdir(evidenceDir, { recursive: true });
let comparisonRoot = baselineRoot;
let comparisonSha = baselineSha;
let baselineLabel = "v0.0.7";

function executable(root) {
  const output = join(root, "studio/out");
  if (process.platform === "darwin") return join(output, "MpVFX-darwin-arm64/MpVFX.app/Contents/MacOS/MpVFX");
  if (process.platform === "win32") return join(output, "MpVFX-win32-x64/MpVFX.exe");
  return join(output, "MpVFX-linux-x64/MpVFX");
}

function runPackaged(variant, path, allowFailure = false) {
  console.log(`Packaged ${variant} acceptance: ${path}`);
  const result = spawnSync(process.execPath, ["tests/e2e/library-workflow.mjs"], {
    cwd: studio,
    env: { ...process.env, MPVFX_UI_COMPARISON: "1", MPVFX_UI_VARIANT: variant, MPVFX_PACKAGED_APP: path, MPVFX_UI_EVIDENCE_DIR: evidenceDir },
    stdio: "inherit",
    timeout: 300_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${variant} packaged acceptance exited ${result.status}`);
  return result.status;
}

if (process.platform === "win32") {
  const originalStatus = runPackaged("original-v007", executable(baselineRoot), true);
  if (originalStatus !== 0) {
    const failure = JSON.parse(await readFile(join(evidenceDir, "original-v007-failure.json"), "utf8"));
    if (!`${failure.error}\n${failure.startupLog}`.includes("EPERM: operation not permitted, fsync"))
      throw new Error("The immutable v0.0.7 Windows app failed for a reason other than its documented file flush bug");
    const compatibilityRoot = process.env.MPVFX_WINDOWS_COMPAT_ROOT;
    if (!compatibilityRoot) throw new Error("MPVFX_WINDOWS_COMPAT_ROOT is required after the original v0.0.7 flush failure");
    const compatibilitySha = execFileSync("git", ["-C", compatibilityRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (compatibilitySha !== "fd598a6daf74d1228d1aa2cb2fad84dba8faa818")
      throw new Error(`Windows compatibility baseline is not the reviewed flush fix: ${compatibilitySha}`);
    comparisonRoot = compatibilityRoot;
    comparisonSha = compatibilitySha;
    baselineLabel = "v0.0.7 + Windows file flush fix";
  }
}

async function installedLinuxExecutable(root, variant) {
  const folder = join(root, "studio/out/make/deb/x64");
  const files = (await readdir(folder)).filter(file => file.endsWith(".deb"));
  if (files.length !== 1) throw new Error(`Expected one ${variant} Debian installer in ${folder}, found ${files.length}`);
  const deb = join(folder, files[0]);
  const command = variant === "candidate" ? ["dpkg", "-i", deb] : ["apt-get", "install", "--yes", deb];
  execFileSync("sudo", command, { stdio: "inherit", env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } });
  const helper = await stat("/usr/lib/mpvfx/chrome-sandbox");
  if (helper.uid !== 0 || (helper.mode & 0o7777) !== 0o4755)
    throw new Error(`Installed ${variant} Electron sandbox helper lacks package-managed root ownership and mode 4755`);
  return "/usr/lib/mpvfx/MpVFX";
}

for (const [variant, root] of [["baseline", comparisonRoot], ["candidate", repo]]) {
  const path = process.platform === "linux" ? await installedLinuxExecutable(root, variant) : executable(root);
  runPackaged(variant, path);
}

const oldPath = join(evidenceDir, "baseline-selected-editor.png");
const newPath = join(evidenceDir, "candidate-selected-editor.png");
const diffPath = join(evidenceDir, "v007-candidate-diff.png");
const oldLayout = JSON.parse(await readFile(join(evidenceDir, "baseline-ui-layout.json"), "utf8"));
const newLayout = JSON.parse(await readFile(join(evidenceDir, "candidate-ui-layout.json"), "utf8"));
const { size, changedPixels, changedPercent, shiftedLayoutFields, diffPng, accepted } = comparePackagedUi(
  await readFile(oldPath), await readFile(newPath), oldLayout, newLayout,
);
await writeFile(diffPath, diffPng);
const report = { baseline: baselineLabel, baselineSha: comparisonSha, immutableV007Sha: baselineSha,
  originalV007WindowsFailure: process.platform === "win32" && comparisonRoot !== baselineRoot ? join(evidenceDir, "original-v007-failure.json") : null,
  candidate: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  platform: process.platform, size, changedPixels, changedPercent, shiftedLayoutFields,
  baselineScreenshot: oldPath, candidateScreenshot: newPath, diffScreenshot: diffPath };
await writeFile(join(evidenceDir, "comparison.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!accepted)
  throw new Error(`Packaged interface differs from ${baselineLabel}; inspect comparison.json and screenshots`);
