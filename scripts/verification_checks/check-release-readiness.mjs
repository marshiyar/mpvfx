import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const failures = [];
const pathOf = (path) => resolve(root, path);
const text = (path) => readFileSync(pathOf(path), "utf8");
const required = [
  "LICENSE", "README.md", "studio/package.json", "studio/package-lock.json",
  "third_party/video-keyframing/bindings/node/vkf_node.cpp",
  "studio/legal/NOTICES/NOTICE.txt", "studio/legal/NOTICES/Apache-2.0.txt",
  "studio/legal/NOTICES/GPL-3.0.txt", "studio/legal/NOTICES/GSAP-NOTICE.txt",
  "studio/legal/NOTICES/THIRD_PARTY_NOTICES.md",
  "studio/legal/NOTICES/FFMPEG_SOURCE.md", "studio/legal/NOTICES/REMOTE_ASSETS.md",
  ".github/workflows/tests.yml", ".github/workflows/desktop.yml",
  ".github/workflows/security.yml", ".github/workflows/release.yml",
  "scripts/third_party/ffmpeg-runtime-manifest.json",
];
for (const path of required) {
  if (!existsSync(pathOf(path))) failures.push(`Missing release input: ${path}`);
}
if (failures.length) throw new Error(failures.join("\n"));

const pkg = JSON.parse(text("studio/package.json"));
const lock = JSON.parse(text("studio/package-lock.json"));
if (pkg.name !== "mpvfx" || pkg.productName !== "MpVFX" || pkg.private !== true) {
  failures.push("MpVFX package identity or private npm status changed");
}
if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || lock.packages?.[""]?.version !== pkg.version) {
  failures.push("Application and lockfile versions disagree");
}
if (pkg.license !== "Apache-2.0" || lock.packages?.[""]?.license !== "Apache-2.0") {
  failures.push("Application license metadata changed");
}
if (Object.hasOwn(pkg, "publishConfig")) failures.push("The desktop app must not be npm-publishable");
if (!text("LICENSE").includes("Apache License")) failures.push("Root Apache license is missing");

const release = text(".github/workflows/release.yml");
if (!release.includes('tags: ["v*"]') || !release.includes("workflow_dispatch:") || release.includes("pull_request:")) {
  failures.push("Release workflow must be tag or manual only");
}
for (const marker of ["SHA256SUMS", "ffmpeg-corresponding-source", "gh release create", "--verify-tag"]) {
  if (!release.includes(marker)) failures.push(`Release workflow lost ${marker}`);
}
for (const marker of ["desktop:make:mac:arm64", "desktop:make:windows", "desktop:make:linux"]) {
  if (!release.includes(marker)) failures.push(`Release workflow lost supported build ${marker}`);
}
const engineBuild = text("studio/native/vkf/build.mjs");
if (!engineBuild.includes("../third_party/video-keyframing")) {
  failures.push("Default engine build no longer uses repository source");
}

const ffmpeg = JSON.parse(text("scripts/third_party/ffmpeg-runtime-manifest.json"));
if (ffmpeg.ffmpegVersion !== "8.1.2" || ffmpeg.binaryLicense !== "GPL-3.0-or-later") {
  failures.push("FFmpeg version or redistribution terms changed");
}
for (const target of ["darwin-arm64", "linux-x64", "win32-x64"]) {
  for (const kind of ["ffmpeg", "ffprobe"]) {
    if (!/^[a-f0-9]{64}$/.test(ffmpeg.targets?.[target]?.[kind]?.sha256 ?? "")) {
      failures.push(`Missing pinned ${kind} checksum for ${target}`);
    }
  }
}

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const forbiddenPrefixes = [".agents/", ".codex/", ".claude/", "studio/data/projects/", "studio/renders/"];
const secretExtensions = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);
for (const path of tracked) {
  const name = basename(path);
  if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix)) ||
      name === ".env" || (name.startsWith(".env.") && name !== ".env.example") ||
      secretExtensions.has(extname(name)) || path.includes("/__pycache__/")) {
    failures.push(`Private, generated or credential path is tracked: ${path}`);
  }
}

if (failures.length) throw new Error(failures.join("\n"));
console.log(`Release inputs verified for MpVFX v${pkg.version}; ${tracked.length} tracked paths scanned.`);
