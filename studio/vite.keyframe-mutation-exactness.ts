import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * The Studio server delegates GSAP mutations to the published parser writer.
 * Its former percentage tolerances made two distinct 30fps frames of a long
 * tween interchangeable. The install script patches the active published
 * writer; this guard makes a skipped postinstall fail loudly at dev startup
 * rather than quietly corrupting a project.
 */
export const EXACT_KEYFRAME_WRITER_FILES = [
  "gsapWriterAcorn.js",
  "gsapParser.js",
] as const;

const FORBIDDEN_WRITER_MARKERS = [
  "var OBJECT_ARRAY_PERCENTAGE_TOLERANCE = 2;",
  "var PCT_TOLERANCE = 2;",
  "var MOVE_NOOP_EPSILON_PCT = 0.05;",
  "var roundPercentage = (percentage) => Math.round(percentage * 10) / 10;",
  "bestDistance <= tolerance || options?.fallbackToNearest ? match : null;",
] as const;

const REQUIRED_WRITER_MARKERS = [
  "var OBJECT_ARRAY_PERCENTAGE_TOLERANCE = 0;",
  "var PCT_TOLERANCE = 0;",
  "var MOVE_NOOP_EPSILON_PCT = 0;",
  "var roundPercentage = (percentage) => percentage;",
  "bestDistance <= tolerance ? match : null;",
] as const;

export function assertInstalledExactKeyframeWriter(
  resolvePackage: () => string = () => require.resolve("@hyperframes/parsers/package.json"),
  readSource: (path: string) => string = (path) => readFileSync(path, "utf8"),
): void {
  const distDir = join(dirname(resolvePackage()), "dist");
  for (const fileName of EXACT_KEYFRAME_WRITER_FILES) {
    const sourcePath = join(distDir, fileName);
    const source = readSource(sourcePath);
    const invalid = FORBIDDEN_WRITER_MARKERS.find((marker) => source.includes(marker));
    const missing = REQUIRED_WRITER_MARKERS.find((marker) => !source.includes(marker));
    if (invalid || missing) {
      throw new Error(
        `[Studio] Exact keyframe writer patch is missing for ${fileName}. ` +
          `Run \`npm --prefix studio install\` before mutating a project.`,
      );
    }
  }
}
