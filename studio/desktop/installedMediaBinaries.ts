import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface MediaBinaryModuleSpecifiers {
  ffmpegPackageJson: "ffmpeg-static/package.json";
  ffmpegFile: "ffmpeg" | "ffmpeg.exe";
  ffprobeSpecifier: string;
  esbuildSpecifier: string;
}

const SUPPORTED_TARGETS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm",
  "linux-arm64",
  "linux-ia32",
  "linux-x64",
  "win32-ia32",
  "win32-x64",
]);

/**
 * Resolve the exact platform package without evaluating either installer's
 * environment-aware entrypoint. In particular, `ffmpeg-static` honors the
 * external FFMPEG_BIN variable and the generic FFprobe installer honors npm
 * target overrides; neither is an acceptable source of truth inside MpVFX.
 */
export function resolveMediaBinaryModuleSpecifiers(
  platform: NodeJS.Platform,
  arch: string,
): MediaBinaryModuleSpecifiers {
  const target = `${platform}-${arch}`;
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`MpVFX has no bundled media runtime for ${target}`);
  }
  const windows = platform === "win32";
  return {
    ffmpegPackageJson: "ffmpeg-static/package.json",
    ffmpegFile: windows ? "ffmpeg.exe" : "ffmpeg",
    ffprobeSpecifier: `@ffprobe-installer/${target}/${windows ? "ffprobe.exe" : "ffprobe"}`,
    esbuildSpecifier: `@esbuild/${target}/${windows ? "esbuild.exe" : "bin/esbuild"}`,
  };
}

export function resolveInstalledMediaBinaryPaths(input: {
  platform?: NodeJS.Platform;
  arch?: string;
  resolveModule?: (specifier: string) => string;
} = {}): { ffmpegPath: string; ffprobePath: string; esbuildPath: string } {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const resolveModule = input.resolveModule ?? createRequire(import.meta.url).resolve;
  const specifiers = resolveMediaBinaryModuleSpecifiers(platform, arch);
  const ffmpegPackageJson = resolveModule(specifiers.ffmpegPackageJson);
  return {
    ffmpegPath: join(dirname(ffmpegPackageJson), specifiers.ffmpegFile),
    ffprobePath: resolveModule(specifiers.ffprobeSpecifier),
    esbuildPath: resolveModule(specifiers.esbuildSpecifier),
  };
}
