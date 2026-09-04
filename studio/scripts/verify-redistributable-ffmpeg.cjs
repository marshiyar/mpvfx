const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const manifest = require("./ffmpeg-runtime-manifest.json");

function runtimeTarget(platform, arch) {
  const key = `${platform}-${arch}`;
  const target = manifest.targets[key];
  if (!target) {
    throw new Error(`MpVFX has no audited FFmpeg binary for ${key}`);
  }
  return { key, ...target };
}

function binaryRecord(name, platform, arch) {
  const target = runtimeTarget(platform, arch);
  const record = target[name];
  if (!record?.asset || !record?.sha256) {
    throw new Error(`MpVFX has no audited ${name} binary for ${target.key}`);
  }
  return { key: target.key, ...record };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertPinnedMediaFile(name, path, platform, arch) {
  const target = binaryRecord(name, platform, arch);
  const actual = sha256(path);
  if (actual !== target.sha256) {
    throw new Error(
      `${name} for ${target.key} is not the audited ${manifest.release} binary: expected SHA-256 ${target.sha256}, received ${actual}`,
    );
  }
}

function assertPinnedFfmpegFile(path, platform, arch) {
  assertPinnedMediaFile("ffmpeg", path, platform, arch);
}

function assertPinnedFfprobeFile(path, platform, arch) {
  assertPinnedMediaFile("ffprobe", path, platform, arch);
}

function assertRedistributableFfmpegOutput(output) {
  if (
    /--enable-nonfree/iu.test(output) ||
    /nonfree parts compiled in/iu.test(output) ||
    /not legally redistributable/iu.test(output)
  ) {
    throw new Error("FFmpeg contains nonfree components and cannot be redistributed");
  }
  if (!new RegExp(`ffmpeg version (?:n)?${manifest.ffmpegVersion.replaceAll(".", "\\.")}`, "iu").test(output)) {
    throw new Error(`FFmpeg is not the audited ${manifest.ffmpegVersion} release`);
  }
  for (const flag of ["--enable-gpl", "--enable-version3", "--enable-libx264", "--enable-libvpx"]) {
    if (!output.includes(flag)) {
      throw new Error(`FFmpeg is missing required audited configuration flag ${flag}`);
    }
  }
}

function assertRedistributableFfprobeOutput(output) {
  assertRedistributableFfmpegOutput(output.replace(/^ffprobe version/imu, "ffmpeg version"));
}

function inspectExecutable(path, executableName, outputAssertion) {
  const result = spawnSync(path, ["-hide_banner", "-version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`${executableName} license inspection failed with exit code ${result.status}: ${output.trim()}`);
  }
  outputAssertion(output);
}

function assertExecutableFfmpeg(path) {
  inspectExecutable(path, "FFmpeg", assertRedistributableFfmpegOutput);
}

function assertExecutableFfprobe(path) {
  inspectExecutable(path, "FFprobe", assertRedistributableFfprobeOutput);
}

function installedFfmpegPath(platform = process.platform) {
  const packageJson = require.resolve("ffmpeg-static/package.json");
  return join(dirname(packageJson), platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
}

function installedFfprobePath(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  const packageJson = require.resolve(`@ffprobe-installer/${target}/package.json`);
  return join(dirname(packageJson), platform === "win32" ? "ffprobe.exe" : "ffprobe");
}

function assertInstalledRedistributableFfmpeg(
  platform = process.platform,
  arch = process.arch,
) {
  const path = installedFfmpegPath(platform);
  assertPinnedFfmpegFile(path, platform, arch);
  if (platform === process.platform && arch === process.arch) {
    assertExecutableFfmpeg(path);
  }
  const ffprobePath = installedFfprobePath(platform, arch);
  assertPinnedFfprobeFile(ffprobePath, platform, arch);
  if (platform === process.platform && arch === process.arch) {
    assertExecutableFfprobe(ffprobePath);
  }
  return path;
}

module.exports = {
  assertExecutableFfprobe,
  assertExecutableFfmpeg,
  assertInstalledRedistributableFfmpeg,
  assertPinnedFfprobeFile,
  assertPinnedFfmpegFile,
  assertPinnedMediaFile,
  assertRedistributableFfprobeOutput,
  assertRedistributableFfmpegOutput,
  binaryRecord,
  installedFfmpegPath,
  installedFfprobePath,
  runtimeTarget,
};
