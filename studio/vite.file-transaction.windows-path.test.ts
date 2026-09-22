// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDurableFileTransactionStore } from "./vite.file-transaction";

// Reproduce the Windows default normalizer on every CI host. Keep filesystem
// operations native so the test also creates and recovers real files on macOS/Linux.
vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof import("node:path")>();
  return { ...path, normalize: path.win32.normalize };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("commits and recovers slash-separated native keyframe sidecars on Windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-windows-transaction-"));
  roots.push(root);
  await mkdir(join(root, ".studio"));
  const target = join(root, ".studio/project.json");
  const before = JSON.stringify({ revision: 1, keyframes: [0, 60] });
  const after = JSON.stringify({ revision: 2, keyframes: [0, 30, 60] });
  await writeFile(target, before);
  const store = createDurableFileTransactionStore({ projectRoot: root });

  const receipt = await store.commit({
    id: "native-keyframes",
    files: [{ path: ".studio/project.json", expectedBefore: before, after }],
  });
  expect(receipt.state).toBe("COMMITTED");
  expect(receipt.files[0].path).toBe(".studio/project.json");
  expect(await readFile(target, "utf8")).toBe(after);

  await writeFile(target, before);
  await createDurableFileTransactionStore({ projectRoot: root }).recover();
  expect(await readFile(target, "utf8")).toBe(after);
});
