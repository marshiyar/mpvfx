import { link, lstat, mkdtemp, rename, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { binaryFileVersion } from "../fileMoves";

const hashing = vi.hoisted(() => ({ reads: 0 }));
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createHash: (...args: Parameters<typeof actual.createHash>) => {
      hashing.reads += 1;
      return actual.createHash(...args);
    },
  };
});

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mpvfx-media-version-cache-"));
  roots.push(root);
  await writeFile(join(root, "a.mov"), "original bytes");
  return root;
}

beforeEach(() => { hashing.reads = 0; });
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("media byte-version cache", () => {
  it("reuses a digest only while the opened file and pathname retain the same exact version", async () => {
    const root = await fixture();
    const first = await binaryFileVersion(root, "a.mov");
    expect(await binaryFileVersion(root, "a.mov")).toBe(first);
    expect(await binaryFileVersion(root, "a.mov")).toBe(first);
    expect(hashing.reads).toBe(1);
    await unlink(join(root, "a.mov"));
    expect(await binaryFileVersion(root, "a.mov")).toBeNull();
  });

  it("re-hashes same-size content edits even when the original modification time is restored", async () => {
    const root = await fixture();
    const first = await binaryFileVersion(root, "a.mov");
    const before = await lstat(join(root, "a.mov"));
    await writeFile(join(root, "a.mov"), "modified bytes");
    await utimes(join(root, "a.mov"), before.atime, before.mtime);
    expect((await lstat(join(root, "a.mov"))).size).toBe(before.size);
    expect(await binaryFileVersion(root, "a.mov")).not.toBe(first);
    expect(hashing.reads).toBe(2);
  });

  it("never reuses a location's digest for a replacement inode with restored time", async () => {
    const root = await fixture();
    const first = await binaryFileVersion(root, "a.mov");
    const before = await lstat(join(root, "a.mov"));
    await writeFile(join(root, "replacement.mov"), "replaced bytes");
    await utimes(join(root, "replacement.mov"), before.atime, before.mtime);
    await rename(join(root, "replacement.mov"), join(root, "a.mov"));
    expect(await binaryFileVersion(root, "a.mov")).not.toBe(first);
    expect(hashing.reads).toBe(2);
  });

  it("shares a validated digest between hardlinks but re-hashes when link changes update ctime", async () => {
    const root = await fixture();
    const first = await binaryFileVersion(root, "a.mov");
    await link(join(root, "a.mov"), join(root, "b.mov"));
    expect(await binaryFileVersion(root, "a.mov")).toBe(first);
    expect(await binaryFileVersion(root, "b.mov")).toBe(first);
    expect(hashing.reads).toBe(2);
    await unlink(join(root, "a.mov"));
    expect(await binaryFileVersion(root, "b.mov")).toBe(first);
    expect(hashing.reads).toBe(3);
  });
});
