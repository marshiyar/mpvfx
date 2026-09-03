import { describe, expect, it, vi } from "vitest";
import { findBundledFfBinary } from "./vite.bundled-media-binaries";

describe("bundled-only media binary lookup", () => {
  it("does not inspect PATH or common system directories when no bundled path is configured", () => {
    const isUsableFile = vi.fn(() => true);

    expect(
      findBundledFfBinary(
        "ffmpeg",
        { configuredMustExist: true },
        {
          environment: { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin" },
          isUsableFile,
          resolvePath: (value) => value,
        },
      ),
    ).toBeUndefined();
    expect(isUsableFile).not.toHaveBeenCalled();
  });

  it.each([
    ["ffmpeg", "HYPERFRAMES_FFMPEG_PATH", "/bundle/ffmpeg"],
    ["ffprobe", "HYPERFRAMES_FFPROBE_PATH", "/bundle/ffprobe"],
  ] as const)("resolves only the configured bundled %s path", (name, key, binaryPath) => {
    expect(
      findBundledFfBinary(
        name,
        { configuredMustExist: true },
        {
          environment: {
            [key]: binaryPath,
            MPVFX_BUNDLED_MEDIA_ROOT: "/bundle",
            PATH: "/usr/bin",
          },
          isUsableFile: (value) => value === binaryPath,
          resolvePath: (value) => value,
        },
      ),
    ).toBe(binaryPath);
  });

  it("fails closed when the configured bundle path is missing", () => {
    expect(
      findBundledFfBinary(
        "ffprobe",
        { configuredMustExist: true },
        {
          environment: { HYPERFRAMES_FFPROBE_PATH: "/bundle/missing-ffprobe" },
          isUsableFile: () => false,
          resolvePath: (value) => value,
        },
      ),
    ).toBeUndefined();
  });

  it("rejects an executable outside the application bundle even when a stale override points to it", () => {
    const isUsableFile = vi.fn(() => true);

    expect(
      findBundledFfBinary(
        "ffmpeg",
        { configuredMustExist: true },
        {
          environment: {
            HYPERFRAMES_FFMPEG_PATH: "/opt/homebrew/bin/ffmpeg",
            MPVFX_BUNDLED_MEDIA_ROOT: "/Applications/MpVFX.app/Contents/Resources/app.asar.unpacked/node_modules",
          },
          isUsableFile,
          resolvePath: (value) => value,
        },
      ),
    ).toBeUndefined();
    expect(isUsableFile).not.toHaveBeenCalled();
  });

  it("rejects a lookalike path that merely shares the bundle-root prefix", () => {
    expect(
      findBundledFfBinary(
        "ffprobe",
        { configuredMustExist: true },
        {
          environment: {
            HYPERFRAMES_FFPROBE_PATH: "/bundle-other/ffprobe",
            MPVFX_BUNDLED_MEDIA_ROOT: "/bundle",
          },
          isUsableFile: () => true,
          resolvePath: (value) => value,
        },
      ),
    ).toBeUndefined();
  });

  it("fails closed when bundle provenance was not established at startup", () => {
    expect(
      findBundledFfBinary(
        "ffmpeg",
        { configuredMustExist: true },
        {
          environment: { HYPERFRAMES_FFMPEG_PATH: "/bundle/ffmpeg" },
          isUsableFile: () => true,
          resolvePath: (value) => value,
        },
      ),
    ).toBeUndefined();
  });
});
