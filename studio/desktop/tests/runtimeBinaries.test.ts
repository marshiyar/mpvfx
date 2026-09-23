import { describe, expect, it } from "vitest";
import {
  applyDesktopRuntimeEnvironment,
  createDesktopRuntimeEnvironment,
  resolvePackagedBinaryPath,
} from "../runtimeBinaries";

describe("packaged media runtime", () => {
  it("resolves native executables outside app.asar", () => {
    expect(
      resolvePackagedBinaryPath(
        "/Applications/MpVFX.app/Contents/Resources/app.asar/node_modules/ffmpeg-static/ffmpeg",
      ),
    ).toBe(
      "/Applications/MpVFX.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg",
    );
  });

  it("replaces stale or user-provided FFmpeg overrides with the bundled executables", () => {
    expect(
      createDesktopRuntimeEnvironment({
        current: {
          HYPERFRAMES_FFMPEG_PATH: "/usr/local/bin/ffmpeg",
          HYPERFRAMES_FFPROBE_PATH:
            "/old/app.asar.unpacked/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe",
          ESBUILD_BINARY_PATH: "/usr/local/bin/esbuild",
        },
        ffmpegPath: "/app.asar/node_modules/ffmpeg-static/ffmpeg",
        ffprobePath:
          "/app.asar/node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
        esbuildPath: "/app.asar/node_modules/@esbuild/darwin-arm64/bin/esbuild",
        browserCacheDir: "/resources/.puppeteer-cache",
      }),
    ).toMatchObject({
      HYPERFRAMES_FFMPEG_PATH:
        "/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg",
      HYPERFRAMES_FFPROBE_PATH:
        "/app.asar.unpacked/node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
      MPVFX_BUNDLED_MEDIA_ROOT: "/app.asar.unpacked/node_modules",
      ESBUILD_BINARY_PATH:
        "/app.asar.unpacked/node_modules/@esbuild/darwin-arm64/bin/esbuild",
      PUPPETEER_CACHE_DIR: "/resources/.puppeteer-cache",
      MPVFX_PREFER_BUNDLED_BROWSER: "1",
    });
  });

  it("applies desktop-only browser and model-cache settings to the live process", () => {
    const keys = [
      "HYPERFRAMES_FFMPEG_PATH", "HYPERFRAMES_FFPROBE_PATH", "MPVFX_BUNDLED_MEDIA_ROOT",
      "ESBUILD_BINARY_PATH", "PUPPETEER_CACHE_DIR", "MPVFX_PREFER_BUNDLED_BROWSER",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      applyDesktopRuntimeEnvironment({
        current: {},
        ffmpegPath: "/runtime/ffmpeg",
        ffprobePath: "/runtime/ffprobe",
        esbuildPath: "/runtime/esbuild",
        browserCacheDir: "/runtime/browser",
      });
      expect(process.env.MPVFX_PREFER_BUNDLED_BROWSER).toBe("1");
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("configures the live FFmpeg environment before native runtime startup", () => {
    const keys = [
      "HYPERFRAMES_FFMPEG_PATH", "HYPERFRAMES_FFPROBE_PATH", "MPVFX_BUNDLED_MEDIA_ROOT",
      "ESBUILD_BINARY_PATH", "PUPPETEER_CACHE_DIR", "MPVFX_PREFER_BUNDLED_BROWSER",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.HYPERFRAMES_FFMPEG_PATH = "/stale/ffmpeg";
      delete process.env.HYPERFRAMES_FFPROBE_PATH;
      applyDesktopRuntimeEnvironment({
        current: process.env,
        ffmpegPath: "/app.asar/vendor/media/ffmpeg",
        ffprobePath: "/app.asar/vendor/media/ffprobe",
        esbuildPath: "/app.asar/vendor/esbuild",
        browserCacheDir: "/runtime/browser",
      });
      expect(process.env.HYPERFRAMES_FFMPEG_PATH).toBe("/app.asar.unpacked/vendor/media/ffmpeg");
      expect(process.env.HYPERFRAMES_FFPROBE_PATH).toBe("/app.asar.unpacked/vendor/media/ffprobe");
      expect(process.env.MPVFX_BUNDLED_MEDIA_ROOT).toBe("/app.asar.unpacked/vendor");
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
});
