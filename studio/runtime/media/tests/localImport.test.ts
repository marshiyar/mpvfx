import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importLocalMedia } from "../localImport";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mpvfx-native-import-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  return { root, projectRoot };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("local media import", () => {
  it("copies files above the old 500 MiB limit without reading their bytes into JavaScript", async () => {
    const { root, projectRoot } = await fixture();
    const source = join(root, "large.wav");
    const file = await open(source, "w");
    await file.truncate(501 * 1024 * 1024);
    await file.write(Buffer.from("end"), 0, 3, 501 * 1024 * 1024 - 3);
    await file.close();
    const result = await importLocalMedia({ projectRoot, paths: [source] });
    expect(result).toEqual({ files: ["large.wav"], invalid: [] });
    expect((await stat(join(projectRoot, "large.wav"))).size).toBe(501 * 1024 * 1024);
    const copied = await open(join(projectRoot, "large.wav"), "r");
    const tail = Buffer.alloc(3);
    await copied.read(tail, 0, 3, 501 * 1024 * 1024 - 3);
    await copied.close();
    expect(tail.toString()).toBe("end");
    expect(await readdir(projectRoot)).toEqual(["large.wav"]);
  }, 30_000); // A real 501 MiB disk copy can exceed Vitest's 5s default under full-suite I/O.

  it("preserves Unicode names, avoids collisions, and reports each failed member of a batch", async () => {
    const { root, projectRoot } = await fixture();
    const name = "Khé¿ (demo).png";
    const source = join(root, name);
    await writeFile(source, "new");
    await writeFile(join(root, "empty.png"), "");
    await mkdir(join(projectRoot, "assets"));
    await writeFile(join(projectRoot, "assets", name), "existing");
    const result = await importLocalMedia({ projectRoot, directory: "assets", paths: [source, join(root, "missing.mov"), join(root, "empty.png"), source] });
    expect(result.files).toEqual(["assets/Khé¿ (demo) (2).png", "assets/Khé¿ (demo) (3).png"]);
    expect(result.invalid.map(item => item.name)).toEqual(["missing.mov", "empty.png"]);
    expect(await readFile(join(projectRoot, "assets", name), "utf8")).toBe("existing");
    expect((await readdir(join(projectRoot, "assets"))).some(name => name.startsWith(".mpvfx"))).toBe(false);
  });

  it("rejects traversal, reserved directories, and symlinked destinations", async () => {
    const { root, projectRoot } = await fixture();
    const source = join(root, "a.png");
    await writeFile(source, "media");
    for (const directory of ["../escape", ".studio", "assets/../../escape", "node_modules"])
      await expect(importLocalMedia({ projectRoot, directory, paths: [source] })).rejects.toThrow();
    await symlink(root, join(projectRoot, "escape"));
    const result = await importLocalMedia({ projectRoot, directory: "escape", paths: [source] });
    expect(result.files).toEqual([]);
    expect(result.invalid).toHaveLength(1);
  });
});
