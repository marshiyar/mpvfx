import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultSource = fileURLToPath(new URL("../../Crosspost/", import.meta.url));
const defaultOutput = fileURLToPath(new URL("../../studio/.build/Crosspost/", import.meta.url));
export const crosspostResourceNames = Object.freeze([
  "gui.py", "UploadYoutube.py", "UploadFacebook.py", "requirements.txt", "README.md",
]);

function validGeneratedLegalDirectory(root) {
  try {
    const manifestPath = join(root, "manifest.json");
    const manifestInfo = lstatSync(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.nlink !== 1) return false;
    const entries = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(entries) || entries.length === 0) return false;
    const expected = new Set(["manifest.json"]);
    for (const entry of entries) {
      if (!Array.isArray(entry.files) || entry.files.length === 0) return false;
      for (const path of entry.files) {
        if (typeof path !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/(?:LICENSE|COPYING|NOTICE)[A-Za-z0-9_.-]*$/i.test(path)) return false;
        expected.add(path);
      }
    }
    const actual = new Set(["manifest.json"]);
    for (const folder of readdirSync(root, { withFileTypes: true })) {
      if (folder.name === "manifest.json") continue;
      if (!folder.isDirectory()) return false;
      for (const file of readdirSync(join(root, folder.name), { withFileTypes: true })) {
        if (!file.isFile() || lstatSync(join(root, folder.name, file.name)).nlink !== 1) return false;
        actual.add(`${folder.name}/${file.name}`);
      }
    }
    return actual.size === expected.size && [...actual].every(path => expected.has(path));
  } catch { return false; }
}

export function buildCrosspostResources(sourceDir = defaultSource, outputDir = defaultOutput) {
  mkdirSync(outputDir, { recursive: true });
  if (!lstatSync(outputDir).isDirectory()) {
    throw new Error(`Crosspost staging path is not a directory: ${outputDir}`);
  }

  // Forge packages this whole directory. Reject anything outside the explicit
  // resource set, including symlinks, before writing any staged file.
  const allowed = new Set(crosspostResourceNames);
  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    if (entry.name === "legal" && entry.isDirectory() && validGeneratedLegalDirectory(join(outputDir, "legal"))) continue;
    if (entry.name === "bin" && entry.isDirectory()) {
      const binaries = readdirSync(join(outputDir, "bin"), { withFileTypes: true });
      const expected = process.platform === "win32" ? "mpvfx-publisher.exe" : "mpvfx-publisher";
      if (binaries.length === 1 && binaries[0].name === expected && binaries[0].isFile() &&
          lstatSync(join(outputDir, "bin", expected)).nlink === 1) continue;
    }
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
