import { describe, expect, it } from "vitest";
import {
  applyDesktopRuntimeEnvironment,
  createDesktopRuntimeEnvironment,
  resolvePackagedBinaryPath,
} from "./runtimeBinaries";

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
        backgroundRemovalModelsDir: "/user-data/cache/background-removal-models",
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
      MPVFX_BACKGROUND_REMOVAL_MODELS_DIR: "/user-data/cache/background-removal-models",
      MPVFX_PREFER_BUNDLED_BROWSER: "1",
    });
  });

  it("applies desktop-only browser and model-cache settings to the live process", () => {
    const keys = ["MPVFX_PREFER_BUNDLED_BROWSER", "MPVFX_BACKGROUND_REMOVAL_MODELS_DIR"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      applyDesktopRuntimeEnvironment({
        current: {},
        ffmpegPath: "/runtime/ffmpeg",
        ffprobePath: "/runtime/ffprobe",
        esbuildPath: "/runtime/esbuild",
        browserCacheDir: "/runtime/browser",
        backgroundRemovalModelsDir: "/runtime/models",
      });
      expect(process.env.MPVFX_PREFER_BUNDLED_BROWSER).toBe("1");
      expect(process.env.MPVFX_BACKGROUND_REMOVAL_MODELS_DIR).toBe("/runtime/models");
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
