import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function fail(message) {
  failures.push(message);
}

function read(path) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function jsonLines(path) {
  return read(path)
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${index + 1} is not valid JSON`, { cause: error });
      }
    });
}

const required = [
  "README.md",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "PRIVACY.md",
  "SECURITY.md",
  "SUPPORT.md",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".github/dependabot.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/workflows/tests.yml",
  ".github/workflows/desktop.yml",
  ".github/workflows/release.yml",
  ".github/workflows/security.yml",
  "scripts/collect-ffmpeg-corresponding-source.mjs",
  "scripts/ffmpeg-source-manifest.json",
  "docs/ARCHITECTURE.md",
  "docs/DATA_PROVENANCE.md",
  "docs/FFMPEG_DISTRIBUTION.md",
  "docs/GITHUB_SETUP.md",
  "docs/REMOTE_ASSETS.md",
  "docs/RELEASING.md",
  "third_party/licenses/Apache-2.0.txt",
  "third_party/licenses/GPL-3.0.txt",
  "third_party/licenses/GSAP-NOTICE.txt",
  "third_party/stackexchange-video-qa/LICENSE.md",
  "third_party/stackexchange-video-qa/README.md",
  "third_party/stackexchange-video-qa/manual-sources.json",
  "third_party/stackexchange-video-qa/sources.jsonl",
  "third_party/stackexchange-video-qa/data/video-qa.jsonl",
  "studio/resources/legal/MPVFX_LICENSE.txt",
  "studio/resources/legal/NOTICE.txt",
  "studio/resources/legal/PRIVACY.md",
  "studio/resources/legal/REMOTE_ASSETS.md",
  "studio/resources/legal/FFMPEG_SOURCE.md",
  "studio/resources/legal/GSAP-NOTICE.txt",
  "studio/resources/legal/THIRD_PARTY_NOTICES.md",
  "studio/scripts/ffmpeg-runtime-manifest.json",
  "studio/scripts/install-redistributable-ffmpeg.mjs",
  "studio/scripts/verify-redistributable-ffmpeg.cjs",
  "studio/public/ASSET_PROVENANCE.md",
  "studio/tests/e2e/fixtures/ASSET_PROVENANCE.md",
];
for (const path of required) {
  if (!existsSync(resolve(repositoryRoot, path))) fail(`Missing required publication file: ${path}`);
}

const pkg = JSON.parse(read("studio/package.json"));
const lock = JSON.parse(read("studio/package-lock.json"));
if (pkg.name !== "mpvfx" || pkg.productName !== "MpVFX" || pkg.private !== true) {
  fail("studio/package.json must identify MpVFX and remain private");
}
if (pkg.license !== "Apache-2.0") fail("studio/package.json license must be Apache-2.0");
if (Object.hasOwn(pkg, "publishConfig")) fail("Remove npm publishConfig from the private application");
if (lock.packages?.[""]?.name !== "mpvfx") fail("package-lock root name is not mpvfx");
if (lock.packages?.[""]?.license !== "Apache-2.0") {
  fail("package-lock root license must be Apache-2.0");
}

const rootLicense = read("LICENSE");
for (const marker of [
  "Apache License",
  "Version 2.0, January 2004",
  "http://www.apache.org/licenses/",
]) {
  if (!rootLicense.includes(marker)) fail(`Root LICENSE is missing Apache-2.0 marker: ${marker}`);
}
if (!read("docs/GITHUB_SETUP.md").includes("repository name must be exactly `mpvfx`")) {
  fail("docs/GITHUB_SETUP.md must reserve the exact repository name mpvfx");
}

if (existsSync(resolve(repositoryRoot, "data_Q&A"))) {
  fail("Legacy data_Q&A directory still exists; QA material belongs under third_party");
}

for (const path of [
  "studio/tests/qa/videoQaInvariantMap.part1.ts",
  "studio/tests/qa/videoQaInvariantMap.part2.ts",
  "studio/tests/qa/videoQaInvariantMap.part3.ts",
]) {
  if (/\bevidence\s*:/u.test(read(path))) {
    fail(`Copied QA prose must remain in the separately licensed corpus, not ${path}`);
  }
}

const corpus = jsonLines("third_party/stackexchange-video-qa/data/video-qa.jsonl");
const sources = jsonLines("third_party/stackexchange-video-qa/sources.jsonl");
if (corpus.length !== 593) {
  fail(`QA corpus count changed without updating its documented provenance: ${corpus.length}`);
}
const expected = new Set(
  corpus.flatMap((question) => [
    `question:${question.question_id}`,
    ...(question.answers ?? []).map((answer) => `answer:${answer.answer_id}`),
  ]),
);
const attributed = new Set(sources.map((source) => `${source.post_type}:${source.post_id}`));
if (expected.size !== attributed.size || [...expected].some((key) => !attributed.has(key))) {
  fail(`QA attribution is incomplete: expected ${expected.size}, found ${attributed.size}`);
}
if (sources.length !== expected.size) {
  fail(`QA attribution contains duplicate or extra records: expected ${expected.size}, found ${sources.length}`);
}
for (const source of sources) {
  const key = `${source.post_type}:${source.post_id}`;
  if (!source.author || !source.source_url || !source.created_at || !source.changes) {
    fail(`QA attribution is missing required identity/change fields: ${key}`);
  }
  if (!/^CC BY-SA (?:2\.5|3\.0|4\.0)$/u.test(source.license ?? "")) {
    fail(`QA attribution has an unsupported license: ${key}`);
  }
  if (!/^https:\/\/stackoverflow\.com\/(?:questions\/|a\/)/u.test(source.source_url ?? "")) {
    fail(`QA attribution does not use a direct Stack Overflow URL: ${key}`);
  }
  if (!/^https:\/\/creativecommons\.org\/licenses\/by-sa\//u.test(source.license_url ?? "")) {
    fail(`QA attribution does not link its Creative Commons terms: ${key}`);
  }
}

function fallbackFiles(directory) {
  const ignoredDirectories = new Set([
    ".git", ".agents", ".codex", ".cache", ".tmp", "node_modules", "dist",
    "desktop-dist", "out", "coverage", ".vitest", ".puppeteer-cache", "renders",
  ]);
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...fallbackFiles(absolute));
    else if (entry.isFile()) result.push(relative(repositoryRoot, absolute));
  }
  return result;
}

let publicationFiles;
try {
  publicationFiles = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, encoding: "utf8" },
  ).split("\0").filter(Boolean);
} catch {
  publicationFiles = fallbackFiles(repositoryRoot);
}

const forbiddenPrefixes = [
  "studio/fixtures/MpVFX/",
  "studio/fixtures/my-video/",
  "studio/fixtures/storyboard-sample/",
  "studio/data/projects/",
  "studio/renders/",
  ".agents/",
  ".codex/",
  ".claude/",
  ".chatgpt/",
  ".cursor/",
  ".continue/",
  ".windsurf/",
  ".opencode/",
  ".gemini/",
];
const secretExtensions = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);
const textExtensions = new Set([
  "", ".cjs", ".css", ".html", ".js", ".json", ".jsonl", ".jsx", ".md", ".mjs",
  ".svg", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const forbiddenText = [
  ["phc_zjjbX0PnWxERXrMHh", "kEJWj9A9BhGVLRReICgsfTMmpx"].join(""),
  ["calendar.app.google/", "yRHT7oPsHWcqFfFv5"].join(""),
];
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{30,}\b/u,
  /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/u,
  /\bsk-(?:proj-)?[0-9A-Za-z_-]{32,}\b/u,
];
const conversationExportNames = new Set([
  "chat.html",
  "conversations.json",
  "message_feedback.json",
  "shared_conversations.json",
]);
const conversationFingerprints = [
  /"role"\s*:\s*"user"[\s\S]{0,250000}"role"\s*:\s*"assistant"/u,
  /"role"\s*:\s*"assistant"[\s\S]{0,250000}"role"\s*:\s*"user"/u,
  /"conversation_id"\s*:[\s\S]{0,250000}"mapping"\s*:[\s\S]{0,250000}"message"\s*:/u,
  /(?:^|\n)#{1,3}\s+(?:User|Human)\s*\n[\s\S]{0,250000}(?:^|\n)#{1,3}\s+Assistant\s*\n/mu,
  /(?:^|\n)(?:User|Human):\s+.+[\s\S]{0,250000}(?:^|\n)Assistant:\s+.+/mu,
];
const protectedMediaExtensions = new Set([
  ".3dl", ".aac", ".ass", ".avi", ".bmp", ".cube", ".flac", ".gif", ".heic",
  ".heif", ".jpeg", ".jpg", ".lut", ".m4a", ".m4v", ".mkv", ".mov", ".mp3",
  ".mp4", ".mpeg", ".mpg", ".ogg", ".opus", ".png", ".srt", ".tif", ".tiff",
  ".vtt", ".wav", ".webm", ".webp",
]);
const allowedMedia = new Map([
  [
    "studio/tests/e2e/fixtures/design-panel-qa/assets/test.mp4",
    "4662cef1ee4423640d4db8b8880ea889d6e0af6e4466d88f5ee15f2dc6d18030",
  ],
]);
const forbiddenAssetDigests = new Map([
  [
    "d7f1a4221e7a9855ae13dfb889357fa164eed33bea2f7f2c27ced532b5ae6bbc",
    "former upstream favicon",
  ],
]);

for (const path of publicationFiles) {
  if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
    fail(`Private/local path is publishable: ${path}`);
  }
  const name = basename(path);
  if (
    conversationExportNames.has(name.toLowerCase())
    || /(?:\.chatlog|\.chat-transcript\.|\.conversation-export\.)/iu.test(name)
  ) {
    fail(`AI conversation export is publishable: ${path}`);
  }
  if ((name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) || secretExtensions.has(extname(name))) {
    fail(`Potential secret file is publishable: ${path}`);
  }
  const absolute = resolve(repositoryRoot, path);
  const stat = lstatSync(absolute);
  if (stat.size > 50 * 1024 * 1024) fail(`Publishable file exceeds GitHub's safe size boundary: ${path}`);
  const mediaExtension = extname(path).toLowerCase();
  if (protectedMediaExtensions.has(mediaExtension)) {
    const expectedDigest = allowedMedia.get(path);
    if (!expectedDigest) {
      fail(`Personal or unreviewed media file is publishable: ${path}`);
    } else {
      const actualDigest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      if (actualDigest !== expectedDigest) {
        fail(`Allowlisted smoke-test media checksum changed: ${path}`);
      }
    }
  }
  if (mediaExtension === ".svg") {
    const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    const forbiddenAsset = forbiddenAssetDigests.get(digest);
    if (forbiddenAsset) fail(`Forbidden ${forbiddenAsset} asset is publishable: ${path}`);
  }
  if (stat.size <= 15 * 1024 * 1024 && textExtensions.has(extname(path))) {
    const content = readFileSync(absolute, "utf8");
    for (const value of forbiddenText) {
      if (content.includes(value)) fail(`Inherited external destination remains in ${path}`);
    }
    if (!path.startsWith("third_party/stackexchange-video-qa/data/")) {
      for (const pattern of credentialPatterns) {
        if (pattern.test(content)) fail(`Possible embedded credential remains in ${path}`);
      }
      for (const pattern of conversationFingerprints) {
        if (pattern.test(content)) {
          fail(`Possible AI conversation transcript remains in ${path}`);
          break;
        }
      }
    }
  }
}

const desktopWorkflow = read(".github/workflows/desktop.yml");
if (/actions\/upload-artifact|electron-forge publish|gh release|action-gh-release/iu.test(desktopWorkflow)) {
  fail("Desktop validation workflow must not upload or publish unsigned installers");
}

const runtimeManifest = JSON.parse(read("studio/scripts/ffmpeg-runtime-manifest.json"));
const sourceManifest = JSON.parse(read("scripts/ffmpeg-source-manifest.json"));
if (runtimeManifest.release !== "n8.1.2-1" || runtimeManifest.ffmpegVersion !== "8.1.2") {
  fail("FFmpeg runtime manifest must remain pinned to the audited n8.1.2-1 release");
}
if (runtimeManifest.binaryLicense !== "GPL-3.0-or-later") {
  fail("FFmpeg runtime manifest must record the effective GPLv3-or-later license");
}
if (runtimeManifest.minimumMacOSVersion !== "15.0") {
  fail("FFmpeg runtime and application minimum macOS version must agree on 15.0");
}
const auditedTargets = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];
if (Object.keys(runtimeManifest.targets ?? {}).sort().join("\n") !== auditedTargets.join("\n")) {
  fail("FFmpeg runtime manifest must contain exactly the four supported desktop targets");
}
for (const target of auditedTargets) {
  for (const program of ["ffmpeg", "ffprobe"]) {
    const record = runtimeManifest.targets?.[target]?.[program];
    if (!record?.asset?.startsWith(`${program}-`) || !/^[a-f0-9]{64}$/u.test(record?.sha256 ?? "")) {
      fail(`FFmpeg runtime manifest has no pinned ${program} asset for ${target}`);
    }
  }
}
if (sourceManifest.binaryRelease !== runtimeManifest.release) {
  fail("FFmpeg source manifest does not match the selected binary release");
}
if (!Array.isArray(sourceManifest.components) || sourceManifest.components.length !== 9) {
  fail("FFmpeg corresponding-source manifest must contain all nine source/build inputs");
} else {
  for (const component of sourceManifest.components) {
    if (!component.url || !component.filename || !/^[a-f0-9]{64}$/u.test(component.sha256 ?? "")) {
      fail(`FFmpeg source input is not completely pinned: ${component.name ?? "unnamed"}`);
    }
  }
}

const ffmpegInstaller = read("studio/scripts/install-redistributable-ffmpeg.mjs");
const ffmpegVerifier = read("studio/scripts/verify-redistributable-ffmpeg.cjs");
if (!pkg.scripts?.postinstall?.includes("install-redistributable-ffmpeg.mjs")) {
  fail("npm postinstall must replace package-supplied FFmpeg suite binaries");
}
for (const marker of ["target.ffmpeg", "target.ffprobe", "sha256"]) {
  if (!ffmpegInstaller.includes(marker)) fail(`FFmpeg installer is missing safety marker: ${marker}`);
}
for (const marker of ["--enable-nonfree", "not legally redistributable", "assertPinnedFfprobeFile"]) {
  if (!ffmpegVerifier.includes(marker)) fail(`FFmpeg verifier is missing rejection marker: ${marker}`);
}

const ffmpegDistribution = read("docs/FFMPEG_DISTRIBUTION.md");
for (const marker of [
  "does **not** use",
  "--enable-nonfree",
  "ffmpeg-corresponding-source-n8.1.2-1.tar.gz",
  "macOS 15.0",
]) {
  if (!ffmpegDistribution.includes(marker)) fail(`FFmpeg distribution record is missing: ${marker}`);
}

const releaseWorkflow = read(".github/workflows/release.yml");
if (
  !releaseWorkflow.includes('tags: ["v*"]')
  || !releaseWorkflow.includes("workflow_dispatch:")
  || releaseWorkflow.includes("pull_request:")
) {
  fail("Release workflow must run from a version tag or manual release request");
}
for (const marker of [
  "SHA256SUMS",
  "ffmpeg-corresponding-source",
  "gh release create",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
]) {
  if (!releaseWorkflow.includes(marker)) fail(`Release workflow is missing safety marker: ${marker}`);
}
for (const forbidden of [
  "environment: release",
  "MACOS_CERTIFICATE",
  "WINDOWS_CERTIFICATE",
  "MPVFX_RELEASE_BUILD",
]) {
  if (releaseWorkflow.includes(forbidden)) {
    fail(`Release workflow still requires signing configuration: ${forbidden}`);
  }
}

if (failures.length > 0) {
  console.error(`Release-readiness check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Release-readiness check passed: ${publicationFiles.length} publishable files, ${expected.size} attributed QA posts, no local projects or inherited destinations.`,
  );
}
