import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function fail(message) {
  failures.push(message);
}

function pathOf(path) {
  return resolve(repositoryRoot, path);
}

function read(path) {
  return readFileSync(pathOf(path), "utf8");
}

const required = [
  "README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md",
  "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "PRIVACY.md", "SECURITY.md", "SUPPORT.md",
  ".editorconfig", ".gitattributes", ".gitignore", ".github/dependabot.yml",
  ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml", ".github/workflows/tests.yml",
  ".github/workflows/desktop.yml", ".github/workflows/release.yml",
  ".github/workflows/security.yml", "scripts/collect-ffmpeg-corresponding-source.mjs",
  "scripts/ffmpeg-source-manifest.json", "docs/ARCHITECTURE.md", "docs/DATA_PROVENANCE.md",
  "docs/FFMPEG_DISTRIBUTION.md", "docs/REMOTE_ASSETS.md", "docs/RELEASING.md",
  "third_party/licenses/Apache-2.0.txt", "third_party/licenses/GPL-3.0.txt",
  "third_party/licenses/GSAP-NOTICE.txt", "studio/resources/legal/MPVFX_LICENSE.txt",
  "studio/resources/legal/NOTICE.txt", "studio/resources/legal/PRIVACY.md",
  "studio/resources/legal/REMOTE_ASSETS.md", "studio/resources/legal/FFMPEG_SOURCE.md",
  "studio/resources/legal/GSAP-NOTICE.txt", "studio/resources/legal/THIRD_PARTY_NOTICES.md",
  "studio/scripts/ffmpeg-runtime-manifest.json", "studio/scripts/install-redistributable-ffmpeg.mjs",
  "studio/scripts/verify-redistributable-ffmpeg.cjs", "studio/public/ASSET_PROVENANCE.md",
  "studio/tests/e2e/fixtures/ASSET_PROVENANCE.md",
];
for (const path of required) {
  if (!existsSync(pathOf(path))) fail(`Missing required publication file: ${path}`);
}

const pkg = JSON.parse(read("studio/package.json"));
const lock = JSON.parse(read("studio/package-lock.json"));
if (pkg.name !== "mpvfx" || pkg.productName !== "MpVFX" || pkg.private !== true) {
  fail("studio/package.json must identify MpVFX and remain private");
}
if (pkg.license !== "Apache-2.0") fail("studio/package.json license must be Apache-2.0");
if (Object.hasOwn(pkg, "publishConfig")) fail("Remove npm publishConfig from the private application");
if (lock.packages?.[""]?.name !== "mpvfx") fail("package-lock root name is not mpvfx");
if (lock.packages?.[""]?.license !== "Apache-2.0") fail("package-lock root license must be Apache-2.0");

const license = read("LICENSE");
for (const marker of ["Apache License", "Version 2.0, January 2004", "http://www.apache.org/licenses/"]) {
  if (!license.includes(marker)) fail(`Root LICENSE is missing Apache-2.0 marker: ${marker}`);
}

if (existsSync(pathOf("data_Q&A"))) {
  fail("Legacy data_Q&A directory still exists; QA material belongs under third_party");
}

for (const path of [
  "studio/tests/qa/videoQaInvariantMap.part1.ts",
  "studio/tests/qa/videoQaInvariantMap.part2.ts",
  "studio/tests/qa/videoQaInvariantMap.part3.ts",
]) {
  if (existsSync(pathOf(path)) && /\bevidence\s*:/u.test(read(path))) {
    fail(`Copied QA prose must remain in the separately licensed corpus, not ${path}`);
  }
}

let publicationFiles = [];
try {
  publicationFiles = execFileSync(
    "git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, encoding: "utf8" },
  ).split("\0").filter(Boolean);
} catch {
  // The publication scan is best-effort outside a Git checkout.
}

const forbiddenPrefixes = [
  "studio/fixtures/MpVFX/", "studio/fixtures/my-video/", "studio/fixtures/storyboard-sample/",
  "studio/data/projects/", "studio/renders/", ".agents/", ".codex/", ".claude/",
  ".chatgpt/", ".cursor/", ".continue/", ".windsurf/", ".opencode/", ".gemini/",
];
const secretExtensions = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);
const protectedMediaExtensions = new Set([
  ".3dl", ".aac", ".ass", ".avi", ".bmp", ".cube", ".flac", ".gif", ".heic", ".heif",
  ".jpeg", ".jpg", ".lut", ".m4a", ".m4v", ".mkv", ".mov", ".mp3", ".mp4", ".mpeg",
  ".mpg", ".ogg", ".opus", ".png", ".srt", ".tif", ".tiff", ".vtt", ".wav", ".webm", ".webp",
]);
const allowedMedia = "studio/tests/e2e/fixtures/design-panel-qa/assets/test.mp4";
const allowedDigest = "4662cef1ee4423640d4db8b8880ea889d6e0af6e4466d88f5ee15f2dc6d18030";
for (const path of publicationFiles) {
  if (extname(path).toLowerCase() === ".csv") {
    fail("Private CSV files cannot be published (filename withheld)");
    continue; // Refuse without reading private CSV contents.
  }
  if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) fail(`Private/local path is publishable: ${path}`);
  const name = basename(path);
  if ((name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) || secretExtensions.has(extname(name))) {
    fail(`Potential secret file is publishable: ${path}`);
  }
  const absolute = pathOf(path);
  const stat = lstatSync(absolute);
  if (stat.size > 50 * 1024 * 1024) fail(`Publishable file exceeds GitHub's safe size boundary: ${path}`);
  if (protectedMediaExtensions.has(extname(path).toLowerCase())) {
    if (path !== allowedMedia) fail(`Personal or unreviewed media file is publishable: ${path}`);
    else if (createHash("sha256").update(readFileSync(absolute)).digest("hex") !== allowedDigest) {
      fail(`Allowlisted smoke-test media checksum changed: ${path}`);
    }
  }
}

const desktopWorkflow = read(".github/workflows/desktop.yml");
if (/actions\/upload-artifact|electron-forge publish|gh release|action-gh-release/iu.test(desktopWorkflow)) {
  fail("Desktop validation workflow must not upload or publish unsigned installers");
}
const securityWorkflow = read(".github/workflows/security.yml");
for (const marker of ["actions: read", "contents: read", "security-events: read", "upload: never", "upload-database: false"]) {
  if (!securityWorkflow.includes(marker)) fail(`CodeQL workflow is missing required permission: ${marker}`);
}
const releaseWorkflow = read(".github/workflows/release.yml");
if (!releaseWorkflow.includes('tags: ["v*"]') || !releaseWorkflow.includes("workflow_dispatch:") || releaseWorkflow.includes("pull_request:")) {
  fail("Release workflow must run from a version tag or manual release request");
}
for (const marker of ["SHA256SUMS", "ffmpeg-corresponding-source", "gh release create"]) {
  if (!releaseWorkflow.includes(marker)) fail(`Release workflow is missing safety marker: ${marker}`);
}
for (const forbidden of ["environment: release", "MACOS_CERTIFICATE", "WINDOWS_CERTIFICATE", "MPVFX_RELEASE_BUILD"]) {
  if (releaseWorkflow.includes(forbidden)) fail(`Release workflow still requires signing configuration: ${forbidden}`);
}

if (failures.length > 0) {
  console.error(`Release-readiness check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Release-readiness check passed: ${publicationFiles.length} publishable files; QA corpus checks are not required.`);
}
