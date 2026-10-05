import { copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultSource = fileURLToPath(new URL("../../Crosspost/", import.meta.url));
const defaultOutput = fileURLToPath(new URL("../../studio/.build/Crosspost/", import.meta.url));
export const crosspostResourceNames = Object.freeze([
  "gui.py", "UploadYoutube.py", "UploadFacebook.py", "requirements.txt", "README.md",
]);

export function buildCrosspostResources(sourceDir = defaultSource, outputDir = defaultOutput) {
  mkdirSync(outputDir, { recursive: true });
  if (!lstatSync(outputDir).isDirectory()) {
    throw new Error(`Crosspost staging path is not a directory: ${outputDir}`);
  }

  // Forge packages this whole directory. Reject anything outside the explicit
  // resource set, including symlinks, before writing any staged file.
  const allowed = new Set(crosspostResourceNames);
  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || !entry.isFile() || lstatSync(join(outputDir, entry.name)).nlink !== 1) {
      throw new Error(`Unexpected Crosspost staging entry: ${join(outputDir, entry.name)}`);
    }
  }

  for (const name of crosspostResourceNames) {
    const input = join(sourceDir, name);
    if (!lstatSync(input).isFile()) throw new Error(`Crosspost resource is not a regular file: ${input}`);
    copyFileSync(input, join(outputDir, name));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildCrosspostResources();
}
