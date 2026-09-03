import { describe, expect, it, vi } from "vitest";
import {
  resolveInstalledMediaBinaryPaths,
  resolveMediaBinaryModuleSpecifiers,
} from "./installedMediaBinaries";

describe("installed media binary packages", () => {
  it.each([
    ["darwin", "arm64", "ffmpeg", "@ffprobe-installer/darwin-arm64/ffprobe", "@esbuild/darwin-arm64/bin/esbuild"],
    ["darwin", "x64", "ffmpeg", "@ffprobe-installer/darwin-x64/ffprobe", "@esbuild/darwin-x64/bin/esbuild"],
    ["win32", "x64", "ffmpeg.exe", "@ffprobe-installer/win32-x64/ffprobe.exe", "@esbuild/win32-x64/esbuild.exe"],
    ["linux", "x64", "ffmpeg", "@ffprobe-installer/linux-x64/ffprobe", "@esbuild/linux-x64/bin/esbuild"],
  ] as const)(
    "selects the packaged executables for %s-%s",
    (platform, arch, ffmpegFile, ffprobeSpecifier, esbuildSpecifier) => {
      expect(resolveMediaBinaryModuleSpecifiers(platform, arch)).toEqual({
        ffmpegPackageJson: "ffmpeg-static/package.json",
        ffmpegFile,
        ffprobeSpecifier,
        esbuildSpecifier,
      });
    },
  );

  it("resolves package files directly and never evaluates environment-controlled installer entrypoints", () => {
    const resolveModule = vi.fn((specifier: string) => {
      if (specifier === "ffmpeg-static/package.json") {
        return "/app.asar/node_modules/ffmpeg-static/package.json";
      }
      if (specifier === "@ffprobe-installer/darwin-arm64/ffprobe") {
        return "/app.asar/node_modules/@ffprobe-installer/darwin-arm64/ffprobe";
      }
      if (specifier === "@esbuild/darwin-arm64/bin/esbuild") {
        return "/app.asar/node_modules/@esbuild/darwin-arm64/bin/esbuild";
      }
      throw new Error(`Unexpected module: ${specifier}`);
    });

    expect(
      resolveInstalledMediaBinaryPaths({ platform: "darwin", arch: "arm64", resolveModule }),
    ).toEqual({
      ffmpegPath: "/app.asar/node_modules/ffmpeg-static/ffmpeg",
      ffprobePath: "/app.asar/node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
      esbuildPath: "/app.asar/node_modules/@esbuild/darwin-arm64/bin/esbuild",
    });
    expect(resolveModule).not.toHaveBeenCalledWith("ffmpeg-static");
    expect(resolveModule).not.toHaveBeenCalledWith("@ffprobe-installer/ffprobe");
  });
});
