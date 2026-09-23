import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyFileMove, binaryFileVersion } from "../fileMoves";

const directoryOpen = vi.hoisted(() => ({ error: undefined as string | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (directoryOpen.error && (await actual.lstat(args[0])).isDirectory()) {
        throw Object.assign(new Error("Directory handles are unsupported"), { code: directoryOpen.error });
      }
      return actual.open(...args);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  directoryOpen.error = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("media moves on filesystems without directory handles", () => {
  it.each(["EISDIR", "EPERM", "EACCES"])("preserves forward and rollback behavior when directory open returns %s", async error => {
    const root = await mkdtemp(join(tmpdir(), "mpvfx-directory-sync-"));
    roots.push(root);
    await mkdir(join(root, "media"));
    const bytes = Buffer.from([0, 255, 128, 17, 192]);
    await writeFile(join(root, "media/a.mov"), bytes);
    const move = { from: "media/a.mov", to: "media/b.mov", expectedVersion: (await binaryFileVersion(root, "media/a.mov"))! };
    directoryOpen.error = error;
    await applyFileMove(root, move, "forward");
    expect(await readFile(join(root, "media/b.mov"))).toEqual(bytes);
    await applyFileMove(root, move, "rollback");
    expect(await readFile(join(root, "media/a.mov"))).toEqual(bytes);
  });
});
