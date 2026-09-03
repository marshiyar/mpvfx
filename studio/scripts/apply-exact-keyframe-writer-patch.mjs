import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const FILES = ["gsapWriterAcorn.js", "gsapParser.js"];
const REPLACEMENTS = [
  ["var OBJECT_ARRAY_PERCENTAGE_TOLERANCE = 2;", "var OBJECT_ARRAY_PERCENTAGE_TOLERANCE = 0;"],
  ["var PCT_TOLERANCE = 2;", "var PCT_TOLERANCE = 0;"],
  ["var MOVE_NOOP_EPSILON_PCT = 0.05;", "var MOVE_NOOP_EPSILON_PCT = 0;"],
  [
    "var roundPercentage = (percentage) => Math.round(percentage * 10) / 10;",
    "var roundPercentage = (percentage) => percentage;",
  ],
  [
    "bestDistance <= tolerance || options?.fallbackToNearest ? match : null;",
    "bestDistance <= tolerance ? match : null;",
  ],
];

const distDir = join(dirname(require.resolve("@hyperframes/parsers/package.json")), "dist");
for (const fileName of FILES) {
  const path = join(distDir, fileName);
  let source = readFileSync(path, "utf8");
  let changed = false;
  for (const [before, after] of REPLACEMENTS) {
    if (source.includes(after)) continue;
    if (!source.includes(before)) {
      throw new Error(`Unsupported ${fileName} writer shape: expected ${before}`);
    }
    source = source.replace(before, after);
    changed = true;
  }
  if (changed) writeFileSync(path, source);
}
