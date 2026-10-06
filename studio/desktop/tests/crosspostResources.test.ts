import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

// @ts-expect-error -- plain ESM build script without type declarations
import { buildCrosspostResources, crosspostResourceNames } from "../../../scripts/build/build-crosspost-resources.mjs";
// @ts-expect-error -- plain ESM build script without type declarations
import { buildCrosspostBundle, crosspostBundleName } from "../../../scripts/build/build-crosspost-bundle.mjs";

const temporaryRoots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mpvfx-crosspost-resources-test-"));
  temporaryRoots.push(root);
  const source = join(root, "source");
  const output = join(root, "staged");
  mkdirSync(source);
  for (const name of crosspostResourceNames) writeFileSync(join(source, name), `current ${name}`);
  return { root, source, output };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("stages only the allowlisted Crosspost files on a fresh and repeated build", () => {
  const { source, output } = fixture();
  buildCrosspostResources(source, output);
  expect(readdirSync(output).sort()).toEqual([...crosspostResourceNames].sort());
  writeFileSync(join(output, "gui.py"), "old content");
  buildCrosspostResources(source, output);
  expect(readFileSync(join(output, "gui.py"), "utf8")).toBe("current gui.py");
});

it("rejects an unexpected staged file without deleting or packaging it", () => {
  const { source, output } = fixture();
  mkdirSync(output);
  writeFileSync(join(output, "token.json"), "private token");
  expect(() => buildCrosspostResources(source, output)).toThrow("Unexpected Crosspost staging entry");
  expect(readFileSync(join(output, "token.json"), "utf8")).toBe("private token");
  expect(readdirSync(output)).toEqual(["token.json"]);
});

it.skipIf(process.platform === "win32")("rejects a staged symlink before copying into its target", () => {
  const { root, source, output } = fixture();
  mkdirSync(output);
  const target = join(root, "other-file");
  writeFileSync(target, "untouched");
  symlinkSync(target, join(output, "gui.py"));
  expect(() => buildCrosspostResources(source, output)).toThrow("Unexpected Crosspost staging entry");
  expect(readFileSync(target, "utf8")).toBe("untouched");
});

it("accepts only the generated publisher binary and removes stale output in source-only builds", () => {
  const { source, output } = fixture();
  buildCrosspostResources(source, output);
  mkdirSync(join(output, "bin"));
  writeFileSync(join(output, "bin", crosspostBundleName()), "previous binary");
  buildCrosspostResources(source, output);
  expect(buildCrosspostBundle({ outputDir: output, bundle: false })).toBeNull();
  expect(readdirSync(output).sort()).toEqual([...crosspostResourceNames].sort());
  mkdirSync(join(output, "bin"));
  writeFileSync(join(output, "bin", "token.json"), "private");
  expect(() => buildCrosspostResources(source, output)).toThrow("Unexpected Crosspost staging entry");
});

it("retains only manifest-listed Python license texts between bundled builds", () => {
  const { source, output } = fixture();
  buildCrosspostResources(source, output);
  const legal = join(output, "legal");
  mkdirSync(join(legal, "sample-1.0"), { recursive: true });
  writeFileSync(join(legal, "sample-1.0", "LICENSE"), "license text");
  writeFileSync(join(legal, "manifest.json"), JSON.stringify([{
    name: "sample", version: "1.0", files: ["sample-1.0/LICENSE"],
  }]));
  expect(() => buildCrosspostResources(source, output)).not.toThrow();
  writeFileSync(join(legal, "sample-1.0", "token.json"), "private token");
  expect(() => buildCrosspostResources(source, output)).toThrow("Unexpected Crosspost staging entry");
});
