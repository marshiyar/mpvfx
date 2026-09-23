// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableFileTransactionStore } from "../fileTransaction";
import { binaryFileVersion } from "../fileMoves";

const roots: string[] = [];
const bytes = Buffer.from([0, 255, 192, 128, 10, 13, 240]);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "media-moves-"));
  roots.push(root);
  await mkdir(join(root, "media"));
  await writeFile(join(root, "media/a.mp4"), bytes);
  await writeFile(join(root, "index.html"), '<video src="media/a.mp4">');
  return { root, input: {
    id: "move-1", history: { label: "Rename media", kind: "manual" as const },
    files: [{ path: "index.html", expectedBefore: '<video src="media/a.mp4">', after: '<video src="media/b.mp4">' }],
    moves: [{ from: "media/a.mp4", to: "media/b.mp4", expectedVersion: (await binaryFileVersion(root, "media/a.mp4"))! }],
  } };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable binary moves", () => {
  it("keeps binary bytes exact across rename, restart, and atomic undo", async () => {
    const { root, input } = await fixture();
    const store = createDurableFileTransactionStore({ projectRoot: root });
    expect((await store.commit(input)).moves).toEqual(input.moves);
    expect(await readFile(join(root, "media/b.mp4"))).toEqual(bytes);
    expect(await binaryFileVersion(root, "media/a.mp4")).toBeNull();
    const restarted = createDurableFileTransactionStore({ projectRoot: root });
    expect((await restarted.recover())[0].action).toBe("already-committed");
    const undone = await restarted.commit({ id: "undo-1", historyReplay: { entryId: "entry-1", direction: "undo" },
      files: input.files.map((file) => ({ ...file, expectedBefore: file.after, after: file.expectedBefore })),
      moves: input.moves.map((move) => ({ ...move, from: move.to, to: move.from })),
    });
    expect(undone.historyReplay).toEqual({ entryId: "entry-1", direction: "undo" });
    expect(await readFile(join(root, "media/a.mp4"))).toEqual(bytes);
    expect(await readFile(join(root, "index.html"), "utf8")).toBe(input.files[0].expectedBefore);
    expect((await restarted.status("undo-1"))).toMatchObject({ historyReplay: undone.historyReplay });
  });

  it.each(["afterPrepared", "afterMoveLink", "afterMove", "afterTargetWrite"] as const)(
    "recovers both source names and references after interruption at %s", async (boundary) => {
      const { root, input } = await fixture();
      const interrupted = createDurableFileTransactionStore({ projectRoot: root,
        [boundary]: () => { throw new Error("power loss"); },
      });
      await expect(interrupted.commit(input)).rejects.toThrow("power loss");
      const restarted = createDurableFileTransactionStore({ projectRoot: root });
      expect((await restarted.recover())[0].action).toBe("rolled-back");
      expect(await readFile(join(root, "media/a.mp4"))).toEqual(bytes);
      expect(await binaryFileVersion(root, "media/b.mp4")).toBeNull();
      expect(await readFile(join(root, "index.html"), "utf8")).toBe(input.files[0].expectedBefore);
      expect((await restarted.recover())[0].action).toBe("already-rolled-back");
    },
  );

  it("refuses a destination collision without writing references or replacing bytes", async () => {
    const { root, input } = await fixture();
    await writeFile(join(root, "media/b.mp4"), bytes);
    const store = createDurableFileTransactionStore({ projectRoot: root });
    await expect(store.commit(input)).rejects.toThrow(/changed before commit/);
    expect(await readFile(join(root, "media/b.mp4"))).toEqual(bytes);
    expect(await store.listReceipts()).toEqual([]);
  });

  it("detects destination creation between preparation and move without clobbering it", async () => {
    const { root, input } = await fixture();
    const store = createDurableFileTransactionStore({ projectRoot: root,
      afterPrepared: async () => { await writeFile(join(root, "media/b.mp4"), "external"); },
    });
    await expect(store.commit(input)).rejects.toThrow(/changed before commit/);
    expect((await store.recover())[0].action).toBe("corrupt");
    expect(await readFile(join(root, "media/a.mp4"))).toEqual(bytes);
    expect(await readFile(join(root, "media/b.mp4"), "utf8")).toBe("external");
    expect(await readFile(join(root, "index.html"), "utf8")).toBe(input.files[0].expectedBefore);
  });

  it("validates all recovery targets before rolling back any reference", async () => {
    const { root, input } = await fixture();
    const store = createDurableFileTransactionStore({ projectRoot: root,
      afterTargetWrite: () => { throw new Error("power loss"); },
    });
    await expect(store.commit(input)).rejects.toThrow("power loss");
    await writeFile(join(root, "media/b.mp4"), "outside edit");
    expect((await store.recover())[0].action).toBe("corrupt");
    expect(await readFile(join(root, "media/b.mp4"), "utf8")).toBe("outside edit");
    expect(await readFile(join(root, "index.html"), "utf8")).toBe(input.files[0].after);
  });

  it.each(["afterPrepared", "afterMove"] as const)("does not overwrite reference edits arriving at %s", async (boundary) => {
    const { root, input } = await fixture();
    const store = createDurableFileTransactionStore({ projectRoot: root,
      [boundary]: async () => { await writeFile(join(root, "index.html"), "external edit"); },
    });
    await expect(store.commit(input)).rejects.toThrow(/changed before commit/);
    expect(await readFile(join(root, "index.html"), "utf8")).toBe("external edit");
    expect((await store.recover())[0].action).toBe("corrupt");
    expect(await readFile(join(root, "index.html"), "utf8")).toBe("external edit");
  });

  it("archives an unreferenced file without requiring a text target", async () => {
    const { root, input } = await fixture();
    const store = createDurableFileTransactionStore({ projectRoot: root });
    const move = { ...input.moves[0], to: ".hyperframes/deleted-media/delete-1/a.mp4" };
    expect((await store.commit({ ...input, files: [], moves: [move] })).state).toBe("COMMITTED");
    expect(await readFile(join(root, move.to))).toEqual(bytes);
    expect(await store.commit({ ...input, files: [], moves: [move] })).toMatchObject({ state: "COMMITTED" });
  });

  it.each(["../outside.mp4", ".hyperframes/studio-transactions/file.mp4", "/tmp/outside.mp4"])(
    "rejects unsafe move target %s", async (to) => {
      const { root, input } = await fixture();
      const store = createDurableFileTransactionStore({ projectRoot: root });
      await expect(store.commit({ ...input, moves: [{ ...input.moves[0], to }] })).rejects.toThrow(/Unsafe|Reserved/);
    },
  );

  it("refuses linked parents, overlapping paths, and changed source bytes", async () => {
    const { root, input } = await fixture();
    const store = createDurableFileTransactionStore({ projectRoot: root });
    await symlink(join(root, "media"), join(root, "linked"));
    await expect(store.commit({ ...input, moves: [{ ...input.moves[0], to: "linked/b.mp4" }] })).rejects.toThrow(/Unsafe/);
    await expect(store.commit({ ...input, moves: [{ ...input.moves[0], to: "index.html" }] })).rejects.toThrow(/Duplicate/);
    await writeFile(join(root, "media/a.mp4"), Buffer.from([0, 255, 193, 128, 10, 13, 240]));
    await expect(store.commit(input)).rejects.toThrow(/changed before commit/);
    expect(await store.listReceipts()).toEqual([]);
  });
});
