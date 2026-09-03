import { dirname, resolve } from "node:path";

export function resolvePackagedBinaryPath(binaryPath: string): string {
  return binaryPath.replace(
    /([/\\])app\.asar([/\\])/,
    (_match, before: string, after: string) => `${before}app.asar.unpacked${after}`,
  );
}

interface DesktopRuntimeEnvironmentInput {
  current: NodeJS.ProcessEnv;
  ffmpegPath: string;
  ffprobePath: string;
  esbuildPath: string;
  browserCacheDir: string;
  backgroundRemovalModelsDir: string;
}

function bundledMediaRoot(ffmpegPath: string): string {
  return resolve(dirname(resolvePackagedBinaryPath(ffmpegPath)), "..");
}

/** Build the environment first so configuration is deterministic and unit-testable. */
export function createDesktopRuntimeEnvironment(
  input: DesktopRuntimeEnvironmentInput,
): NodeJS.ProcessEnv {
  return {
    ...input.current,
    // Always replace inherited overrides. A packaged application must use the
    // executables shipped with this exact build, never a user's PATH, shell
    // configuration, FFMPEG_BIN, or a stale path from an older installation.
    HYPERFRAMES_FFMPEG_PATH: resolvePackagedBinaryPath(input.ffmpegPath),
    HYPERFRAMES_FFPROBE_PATH: resolvePackagedBinaryPath(input.ffprobePath),
    ESBUILD_BINARY_PATH: resolvePackagedBinaryPath(input.esbuildPath),
    MPVFX_BUNDLED_MEDIA_ROOT: bundledMediaRoot(input.ffmpegPath),
    PUPPETEER_CACHE_DIR: input.current.PUPPETEER_CACHE_DIR ?? input.browserCacheDir,
    MPVFX_BACKGROUND_REMOVAL_MODELS_DIR:
      input.current.MPVFX_BACKGROUND_REMOVAL_MODELS_DIR ??
      input.backgroundRemovalModelsDir,
    MPVFX_PREFER_BUNDLED_BROWSER:
      input.current.MPVFX_PREFER_BUNDLED_BROWSER ?? "1",
  };
}

export function applyBundledMediaBinaryEnvironment(input: {
  ffmpegPath: string;
  ffprobePath: string;
}): void {
  process.env.HYPERFRAMES_FFMPEG_PATH = resolvePackagedBinaryPath(input.ffmpegPath);
  process.env.HYPERFRAMES_FFPROBE_PATH = resolvePackagedBinaryPath(input.ffprobePath);
  process.env.MPVFX_BUNDLED_MEDIA_ROOT = bundledMediaRoot(input.ffmpegPath);
}

export function applyDesktopRuntimeEnvironment(input: DesktopRuntimeEnvironmentInput): void {
  const configured = createDesktopRuntimeEnvironment(input);
  for (const key of [
    "HYPERFRAMES_FFMPEG_PATH",
    "HYPERFRAMES_FFPROBE_PATH",
    "ESBUILD_BINARY_PATH",
    "MPVFX_BUNDLED_MEDIA_ROOT",
    "PUPPETEER_CACHE_DIR",
    "MPVFX_BACKGROUND_REMOVAL_MODELS_DIR",
    "MPVFX_PREFER_BUNDLED_BROWSER",
  ] as const) {
    const value = configured[key];
    if (value) process.env[key] = value;
  }
}
