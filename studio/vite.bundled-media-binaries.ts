import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type BundledFfBinaryName = "ffmpeg" | "ffprobe";
export type BundledFfBinaryFinder = (
  name: BundledFfBinaryName,
  options?: { configuredMustExist?: boolean },
) => string | undefined;

interface BundledFfBinaryDependencies {
  environment?: NodeJS.ProcessEnv;
  isUsableFile?: (path: string) => boolean;
  resolvePath?: (path: string) => string;
}

const ENVIRONMENT_KEY: Record<BundledFfBinaryName, string> = {
  ffmpeg: "HYPERFRAMES_FFMPEG_PATH",
  ffprobe: "HYPERFRAMES_FFPROBE_PATH",
};

function isWithinRoot(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return (
    offset === "" ||
    (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`))
  );
}

function isUsableBinary(path: string): boolean {
  if (process.platform === "win32") return existsSync(path);
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Application media code may resolve only the package paths established at
 * startup. There is deliberately no PATH scan, `which`, common-directory
 * probe, project-local fallback, or bare `ffmpeg` command fallback here.
 */
export function findBundledFfBinary(
  name: BundledFfBinaryName,
  _options: { configuredMustExist?: boolean } = {},
  dependencies: BundledFfBinaryDependencies = {},
): string | undefined {
  const environment = dependencies.environment ?? process.env;
  const configured = environment[ENVIRONMENT_KEY[name]]?.trim();
  const configuredRoot = environment.MPVFX_BUNDLED_MEDIA_ROOT?.trim();
  if (!configured || !configuredRoot) return undefined;
  const resolved = (dependencies.resolvePath ?? resolve)(configured);
  const resolvedRoot = (dependencies.resolvePath ?? resolve)(configuredRoot);
  if (!isWithinRoot(resolvedRoot, resolved)) return undefined;
  if (!(dependencies.isUsableFile ?? isUsableBinary)(resolved)) return undefined;
  return resolved;
}

export function assertBundledMediaBinariesAvailable(
  findBinary: BundledFfBinaryFinder = findBundledFfBinary,
): void {
  const missing = (["ffmpeg", "ffprobe"] as const).filter(
    (name) => !findBinary(name, { configuredMustExist: true }),
  );
  if (missing.length > 0) {
    throw new Error(
      `MpVFX's bundled ${missing.map((name) => (name === "ffmpeg" ? "FFmpeg" : "FFprobe")).join(" and ")} executable${missing.length > 1 ? "s are" : " is"} missing or damaged. Reinstall MpVFX.`,
    );
  }
}
