// Run the pinned v0.0.7 app and the candidate app on the same CI runner.
// A missing executable, screenshot, or comparison is a failed acceptance run.
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static");
const studio = resolve(import.meta.dirname, "../..");
const repo = resolve(studio, "..");
const baselineRoot = process.env.MPVFX_BASELINE_ROOT;
if (!baselineRoot) throw new Error("MPVFX_BASELINE_ROOT must point to the checked-out v0.0.7 tree");
const baselineSha = execFileSync("git", ["-C", baselineRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (baselineSha !== "fbde94a88cdb022c71d9349b86a6692244d50007")
  throw new Error(`Baseline is not the pinned v0.0.7 commit: ${baselineSha}`);
const evidenceDir = resolve(process.env.MPVFX_UI_EVIDENCE_DIR ?? join(studio, ".build/ui-evidence"));
await mkdir(evidenceDir, { recursive: true });

function executable(root) {
  const output = join(root, "studio/out");
  if (process.platform === "darwin") return join(output, "MpVFX-darwin-arm64/MpVFX.app/Contents/MacOS/MpVFX");
  if (process.platform === "win32") return join(output, "MpVFX-win32-x64/MpVFX.exe");
  return join(output, "MpVFX-linux-x64/MpVFX");
}

for (const [variant, root] of [["baseline", baselineRoot], ["candidate", repo]]) {
  console.log(`Packaged ${variant} acceptance: ${executable(root)}`);
  execFileSync(process.execPath, ["tests/e2e/library-workflow.mjs"], {
    cwd: studio,
    env: { ...process.env, MPVFX_UI_COMPARISON: "1", MPVFX_UI_VARIANT: variant, MPVFX_PACKAGED_APP: executable(root), MPVFX_UI_EVIDENCE_DIR: evidenceDir },
    stdio: "inherit",
    timeout: 300_000,
  });
}

function dimensions(png) {
  if (png.toString("ascii", 1, 4) !== "PNG") throw new Error("Screenshot is not PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function pixels(path, width, height) {
  const result = spawnSync(ffmpeg, ["-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
    { maxBuffer: width * height * 4 + 1024 });
  if (result.status !== 0) throw new Error(`Cannot decode screenshot ${path}: ${result.stderr}`);
  if (result.stdout.length !== width * height * 4) throw new Error(`Wrong screenshot pixel count: ${path}`);
  return result.stdout;
}

const oldPath = join(evidenceDir, "baseline-selected-editor.png");
const newPath = join(evidenceDir, "candidate-selected-editor.png");
const oldPng = await readFile(oldPath);
const newPng = await readFile(newPath);
const oldSize = dimensions(oldPng);
const newSize = dimensions(newPng);
if (oldSize.width !== newSize.width || oldSize.height !== newSize.height)
  throw new Error(`Packaged screenshot size changed: ${JSON.stringify({ oldSize, newSize })}`);
const oldPixels = pixels(oldPath, oldSize.width, oldSize.height);
const newPixels = pixels(newPath, newSize.width, newSize.height);
const diff = Buffer.alloc(oldPixels.length);
let changed = 0;
for (let index = 0; index < oldPixels.length; index += 4) {
  const delta = Math.max(...[0, 1, 2].map(channel => Math.abs(oldPixels[index + channel] - newPixels[index + channel])));
  if (delta > 24) changed++;
  diff[index] = delta > 24 ? 255 : 0;
  diff[index + 1] = 0;
  diff[index + 2] = delta > 24 ? 255 : 0;
  diff[index + 3] = 255;
}
const diffPath = join(evidenceDir, "v007-candidate-diff.png");
const encoded = spawnSync(ffmpeg, ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${oldSize.width}x${oldSize.height}`, "-i", "pipe:0", "-frames:v", "1", diffPath],
  { input: diff, maxBuffer: 1024 * 1024 });
if (encoded.status !== 0) throw new Error(`Cannot write screenshot diff: ${encoded.stderr}`);
const oldLayout = JSON.parse(await readFile(join(evidenceDir, "baseline-ui-layout.json"), "utf8"));
const newLayout = JSON.parse(await readFile(join(evidenceDir, "candidate-ui-layout.json"), "utf8"));
const shifted = Object.keys(oldLayout).filter(key => Math.abs(oldLayout[key] - newLayout[key]) > 4);
const changedPercent = 100 * changed / (oldSize.width * oldSize.height);
const report = { baseline: "v0.0.7", baselineSha, candidate: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  platform: process.platform, size: oldSize, changedPixels: changed, changedPercent, shiftedLayoutFields: shifted,
  baselineScreenshot: oldPath, candidateScreenshot: newPath, diffScreenshot: diffPath };
await writeFile(join(evidenceDir, "comparison.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (shifted.length || changedPercent > 2)
  throw new Error(`Packaged interface differs from the pinned v0.0.7 baseline; inspect comparison.json and screenshots`);
