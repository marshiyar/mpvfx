import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const studioDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "node_modules/@hyperframes/producer/dist/index.js",
  "node_modules/@hyperframes/producer/dist/public-server.js",
  "node_modules/@hyperframes/producer/dist/distributed.js",
  "node_modules/@hyperframes/engine/dist/services/frameCapture.js",
];

const before = "if (!needsBeyondViewport) {";
const after =
  "if (!needsBeyondViewport && !shouldDefaultCaptureBeyondViewport(await session.browser.version())) {";
const downgradeLog =
  "captureBeyondViewport downgraded: page content fits the capture viewport";

for (const relativePath of targets) {
  const path = join(studioDir, relativePath);
  let source = readFileSync(path, "utf8");

  if (source.includes(after)) continue;

  const markerIndex = source.indexOf(downgradeLog);
  if (markerIndex < 0) {
    throw new Error(`Unsupported capture bundle shape in ${relativePath}: downgrade marker is missing`);
  }

  const blockStart = Math.max(0, markerIndex - 700);
  const block = source.slice(blockStart, markerIndex);
  if (!block.includes(before)) {
    throw new Error(`Unsupported capture bundle shape in ${relativePath}: downgrade guard is missing`);
  }

  const replacementIndex = source.lastIndexOf(before, markerIndex);
  source =
    source.slice(0, replacementIndex) +
    after +
    source.slice(replacementIndex + before.length);
  writeFileSync(path, source);
}
