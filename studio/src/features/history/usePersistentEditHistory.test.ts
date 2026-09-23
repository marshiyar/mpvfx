import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDurableFileTransactionStore } from "../../../runtime/projects/fileTransaction";
import {
  applyDurableStudioHistoryTransaction,
  finalizeDurableStudioFileTransaction,
  reconcileDurableStudioFileTransactions,
  type StudioHistoryTransactionInput,
} from "./studioFileTransaction";
import { createEmptyEditHistory } from "./editHistory";
import type { EditHistoryStorageAdapter } from "./editHistoryStorage";
import { createMemoryEditHistoryStorage } from "./editHistoryStorage";
import {
  serializeStudioFileMutation,
  serializeStudioFileMutations,
} from "./studioFileMutationCoordinator";
import {
  createPersistentEditHistoryController,
  createPersistentEditHistoryStore,
} from "./usePersistentEditHistory";

describe("createPersistentEditHistoryController", () => {
  it("durably records a server receipt only after storage succeeds", async () => {
    const storage = createMemoryEditHistoryStorage();
    const changes: ReturnType<typeof createEmptyEditHistory>[] = [];
    const controller = await createPersistentEditHistoryController({
      projectId: "project-1",
      storage,
      now: () => 100,
      onChange: (state) => changes.push(state),
    });

    await controller.recordDurableEdit({
      label: "Move clip",
      kind: "timeline",
      durableTransactionIds: ["server-tx-1"],
      files: { "index.html": { before: "a", after: "b" } },
    });

    expect(changes).toHaveLength(1);
    expect(controller.snapshot().state.undo[0].durableTransactionIds).toEqual(["server-tx-1"]);
    const reloaded = await createPersistentEditHistoryController({
      projectId: "project-1",
      storage,
      now: () => 200,
      onChange: () => {},
    });
    expect(reloaded.snapshot().state.undo[0].durableTransactionIds).toEqual(["server-tx-1"]);
  });

  it("rejects a durable record and publishes no in-memory state when storage fails", async () => {
    const storage: EditHistoryStorageAdapter = {
      async get() {
        return null;
      },
      async set() {
        throw new Error("IndexedDB unavailable");
      },
      async delete() {},
    };
    const onChange = vi.fn();
    const controller = await createPersistentEditHistoryController({
      projectId: "project-1",
      storage,
      now: () => 100,
      onChange,
    });

    await expect(
      controller.recordDurableEdit({
        label: "Move clip",
        kind: "timeline",
        durableTransactionIds: ["server-tx-1"],
        files: { "index.html": { before: "a", after: "b" } },
      }),
    ).rejects.toThrow("IndexedDB unavailable");

    expect(onChange).not.toHaveBeenCalled();
    expect(controller.snapshot().canUndo).toBe(false);
    expect(controller.snapshot().state).toEqual(createEmptyEditHistory());
  });

  it("does not save or publish a replayed receipt already present in redo", async () => {
    const memory = createMemoryEditHistoryStorage();
    const storage: EditHistoryStorageAdapter = {
      get: memory.get,
      set: vi.fn(memory.set),
      delete: memory.delete,
    };
    const onChange = vi.fn();
    const controller = await createPersistentEditHistoryController({
      projectId: "project-1",
      storage,
      now: () => 100,
      onChange,
    });
    const input = {
      label: "Move clip",
      kind: "timeline" as const,
      durableTransactionIds: ["server-tx-1"],
      files: { "index.html": { before: "a", after: "b" } },
    };
    await controller.recordDurableEdit(input);
    await controller.undo({
      readFile: async () => "b",
      writeFile: async () => {},
    });
    const savesBeforeReplay = vi.mocked(storage.set).mock.calls.length;
    const changesBeforeReplay = onChange.mock.calls.length;

    await controller.recordDurableEdit(input);

    expect(vi.mocked(storage.set)).toHaveBeenCalledTimes(savesBeforeReplay);
    expect(onChange).toHaveBeenCalledTimes(changesBeforeReplay);
    expect(controller.snapshot().canUndo).toBe(false);
    expect(controller.snapshot().canRedo).toBe(true);
  });

  it("requires at least one non-empty receipt for the strict durable path", async () => {
    const controller = await createPersistentEditHistoryController({
      projectId: "project-1",
      storage: createMemoryEditHistoryStorage(),
      onChange: () => {},
    });

    await expect(
      controller.recordDurableEdit({
        label: "Move clip",
        kind: "timeline",
        durableTransactionIds: [],
        files: { "index.html": { before: "a", after: "b" } },
      }),
    ).rejects.toThrow("durable transaction ID");
  });

  it("records history and reloads it for the same project", async () => {
    const storage = createMemoryEditHistoryStorage();
    const first = await createPersistentEditHistoryController({
      projectId: "project-1",
      storage,
      now: () => 100,
      onChange: () => {},
    });

    await first.recordEdit({
      label: "Move layer",
      kind: "manual",
      files: { "index.html": { before: "a", after: "b" } },
    });

    const second = await createPersistentEditHistoryController({
      projectId: "project-1",
      storage,
      now: () => 200,
      onChange: () => {},
    });

    expect(second.snapshot().canUndo).toBe(true);
    expect(second.snapshot().undoLabel).toBe("Move layer");
    expect(second.snapshot().undoPaths).toEqual(["index.html"]);
  });

  it("undo applies files through the provided callback and persists redo state", async () => {
    const storage = createMemoryEditHistoryStorage();
    const controller = await createPersistentEditHistoryController({
      projectId: "project-1",
      storage,
      now: () => 100,
      onChange: () => {},
    });
    await controller.recordEdit({
      label: "Move layer",
      kind: "manual",
      files: { "index.html": { before: "a", after: "b" } },
    });

    const result = await controller.undo({
      readFile: async (path) => {
        expect(path).toBe("index.html");
        return "b";
      },
      writeFile: async (path, content) => {
        expect(path).toBe("index.html");
        expect(content).toBe("a");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.paths).toEqual(["index.html"]);

    expect(controller.snapshot().canUndo).toBe(false);
    expect(controller.snapshot().canRedo).toBe(true);
    expect(controller.snapshot().redoPaths).toEqual(["index.html"]);
  });

  it("keeps in-memory history when storage saves fail", async () => {
    const storage: EditHistoryStorageAdapter = {
      async get() {
        return null;
      },
      async set() {
        throw new Error("IndexedDB unavailable");
      },
      async delete() {},
    };
    const controller = await createPersistentEditHistoryController({
      projectId: "project-1",
      storage,
      now: () => 100,
      onChange: () => {},
    });

    await expect(
      controller.recordEdit({
        label: "Move layer",
        kind: "manual",
        files: { "index.html": { before: "a", after: "b" } },
      }),
    ).resolves.toBeUndefined();

    expect(controller.snapshot().canUndo).toBe(true);
  });

  it("serializes concurrent record edits against the latest state", async () => {
    const storage = createMemoryEditHistoryStorage();
    let timestamp = 100;
    const store = createPersistentEditHistoryStore({
      projectId: "project-1",
      storage,
      initialState: createEmptyEditHistory(),
      now: () => timestamp++,
      onChange: () => {},
    });

    await Promise.all([
      store.recordEdit({
        label: "Move layer",
        kind: "manual",
        files: { "index.html": { before: "a", after: "b" } },
      }),
      store.recordEdit({
        label: "Resize layer",
        kind: "manual",
        files: { "index.html": { before: "b", after: "c" } },
      }),
    ]);

    expect(store.snapshot().state.undo.map((entry) => entry.label)).toEqual([
      "Move layer",
      "Resize layer",
    ]);
  });

  it("still coalesces concurrent source edits that share a coalesce key", async () => {
    const storage = createMemoryEditHistoryStorage();
    let timestamp = 100;
    const store = createPersistentEditHistoryStore({
      projectId: "project-1",
      storage,
      initialState: createEmptyEditHistory(),
      now: () => timestamp++,
      onChange: () => {},
    });

    await Promise.all([
      store.recordEdit({
        label: "Edit text",
        kind: "manual",
        coalesceKey: "manual:index.html",
        files: { "index.html": { before: "a", after: "b" } },
      }),
      store.recordEdit({
        label: "Edit text",
        kind: "manual",
        coalesceKey: "manual:index.html",
        files: { "index.html": { before: "b", after: "c" } },
      }),
    ]);

    expect(store.snapshot().state.undo).toHaveLength(1);
    expect(store.snapshot().state.undo[0].files["index.html"].before).toBe("a");
    expect(store.snapshot().state.undo[0].files["index.html"].after).toBe("c");
  });

  it("reads undo hashes from the live top entry during queued undo calls", async () => {
    const storage = createMemoryEditHistoryStorage();
    let timestamp = 100;
    const store = createPersistentEditHistoryStore({
      projectId: "project-1",
      storage,
      initialState: createEmptyEditHistory(),
      now: () => timestamp++,
      onChange: () => {},
    });
    await store.recordEdit({
      label: "Edit first file",
      kind: "manual",
      files: { "first.html": { before: "first-before", after: "first-after" } },
    });
    await store.recordEdit({
      label: "Edit second file",
      kind: "manual",
      files: { "second.html": { before: "second-before", after: "second-after" } },
    });

    const files: Record<string, string> = {
      "first.html": "first-after",
      "second.html": "second-after",
    };
    const readPaths: string[] = [];

    await Promise.all([
      store.undo({
        readFile: async (path) => {
          readPaths.push(path);
          return files[path];
        },
        writeFile: async (path, content) => {
          files[path] = content;
        },
      }),
      store.undo({
        readFile: async (path) => {
          readPaths.push(path);
          return files[path];
        },
        writeFile: async (path, content) => {
          files[path] = content;
        },
      }),
    ]);

    expect(readPaths).toEqual(["second.html", "first.html"]);
    expect(files).toEqual({
      "first.html": "first-before",
      "second.html": "second-before",
    });
    expect(store.snapshot().canUndo).toBe(false);
    expect(store.snapshot().canRedo).toBe(true);
  });

  it("waits for same-file mutations before checking an undo hash", async () => {
    const storage = createMemoryEditHistoryStorage();
    const store = createPersistentEditHistoryStore({
      projectId: "project-1",
      storage,
      initialState: createEmptyEditHistory(),
      now: () => 100,
      onChange: () => {},
    });
    await store.recordEdit({
      label: "Edit text",
      kind: "manual",
      files: { "index.html": { before: "before", after: "after" } },
    });

    let disk = "after";
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writeFile = vi.fn(async (_path: string, content: string) => {
      disk = content;
    });
    const priorMutation = serializeStudioFileMutation(writeFile, "index.html", async () => {
      await blocked;
      disk = "newer-edit";
    });
    const readFile = vi.fn(async () => disk);
    const undo = store.undo({
      readFile,
      writeFile,
      serialize: (paths, task) => serializeStudioFileMutations(writeFile, paths, task),
    });

    await Promise.resolve();
    expect(readFile).not.toHaveBeenCalled();
    release();
    await priorMutation;
    await expect(undo).resolves.toMatchObject({ ok: false, reason: "content-mismatch" });
    expect(disk).toBe("newer-edit");
    expect(writeFile).not.toHaveBeenCalled();
    expect(store.snapshot().canUndo).toBe(true);
  });

  it("returns per-file restored/previous content so the preview can soft-apply", async () => {
    const storage = createMemoryEditHistoryStorage();
    const store = createPersistentEditHistoryStore({
      projectId: "project-1",
      storage,
      initialState: createEmptyEditHistory(),
      now: () => 100,
      onChange: () => {},
    });
    await store.recordEdit({
      label: "Move layer",
      kind: "manual",
      files: { "index.html": { before: "OLD", after: "NEW" } },
    });
    const disk: Record<string, string> = { "index.html": "NEW" };
    const undo = await store.undo({
      readFile: async (p) => disk[p],
      writeFile: async (p, c) => {
        disk[p] = c;
      },
    });
    // `restored` = bytes written (the undo target), `previous` = the current live bytes.
    expect(undo.files).toEqual({ "index.html": { previous: "NEW", restored: "OLD" } });

    const redo = await store.redo({
      readFile: async (p) => disk[p],
      writeFile: async (p, c) => {
        disk[p] = c;
      },
    });
    expect(redo.files).toEqual({ "index.html": { previous: "OLD", restored: "NEW" } });
  });

  it("rolls back files when an undo write fails partway through", async () => {
    const storage = createMemoryEditHistoryStorage();
    const store = createPersistentEditHistoryStore({
      projectId: "project-1",
      storage,
      initialState: createEmptyEditHistory(),
      now: () => 100,
      onChange: () => {},
    });
    await store.recordEdit({
      label: "Edit files",
      kind: "manual",
      files: {
        "first.html": { before: "first-before", after: "first-after" },
        "second.html": { before: "second-before", after: "second-after" },
      },
    });

    const files: Record<string, string> = {
      "first.html": "first-after",
      "second.html": "second-after",
    };
    const result = store.undo({
      readFile: async (path) => files[path],
      writeFile: async (path, content) => {
        if (path === "second.html" && content === "second-before") {
          throw new Error("write failed");
        }
        files[path] = content;
      },
    });

    await expect(result).rejects.toThrow("write failed");
    expect(files).toEqual({
      "first.html": "first-after",
      "second.html": "second-after",
    });
    expect(store.snapshot().undoLabel).toBe("Edit files");
    expect(store.snapshot().canRedo).toBe(false);
  });
});

describe("media move history with the durable filesystem journal", () => {
  async function fixture(run: (fixture: {
    root: string;
    controller: Awaited<ReturnType<typeof createPersistentEditHistoryController>>;
    storage: ReturnType<typeof createMemoryEditHistoryStorage>;
    journal: ReturnType<typeof createDurableFileTransactionStore>;
    fetchImpl: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    callbacks: {
      readFile: (path: string) => Promise<string>;
      writeFile: (path: string, content: string) => Promise<void>;
      applyTransaction: (input: StudioHistoryTransactionInput) => ReturnType<typeof applyDurableStudioHistoryTransaction>;
    };
    rename: () => Promise<void>;
  }) => Promise<void>) {
    const root = await mkdtemp(join(process.cwd(), ".build/history-moves-"));
    try {
      await mkdir(join(root, "media"));
      const bytes = Buffer.from([0, 255, 1, 234, 128, 4]);
      await writeFile(join(root, "media/a.mov"), bytes);
      await writeFile(join(root, "index.html"), "edited media/a.mov");
      const journal = createDurableFileTransactionStore({ projectRoot: root });
      const storage = createMemoryEditHistoryStorage();
      let time = 1;
      const controller = await createPersistentEditHistoryController({ projectId: "demo", storage, now: () => time++, onChange: () => {} });
      const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = String(url);
        if (path.endsWith("/commit")) return Response.json(await journal.commit(JSON.parse(String(init?.body))));
        if (path.endsWith("/pending-history")) return Response.json({ receipts: await journal.listCommittedPendingHistory() });
        if (path.endsWith("/acknowledge")) return Response.json({ ok: await journal.acknowledge(path.split("/").at(-2)!) });
        const receipt = await journal.status(path.split("/").at(-1)!);
        return Response.json(receipt, { status: receipt ? 200 : 404 });
      };
      let replay = 0;
      const callbacks = {
        readFile: (path: string) => readFile(join(root, path), "utf8"),
        writeFile: async () => { throw new Error("History must use its atomic transaction callback"); },
        applyTransaction: (input: StudioHistoryTransactionInput) => applyDurableStudioHistoryTransaction({ ...input, projectId: "demo", transactionId: `replay-${++replay}`, fetchImpl }),
      };
      const rename = async () => {
        const receipt = await journal.commit({ id: "rename-1", files: [{ path: "index.html", expectedBefore: "edited media/a.mov", after: "edited media/b.mov" }], moves: [{ from: "media/a.mov", to: "media/b.mov", expectedVersion: createHash("sha256").update(bytes).digest("hex") }], history: { kind: "manual", label: "Rename media" } });
        await finalizeDurableStudioFileTransaction({ projectId: "demo", receipt, recordDurableEdit: controller.recordDurableEdit, fetchImpl });
      };
      await run({ root, controller, storage, journal, fetchImpl, callbacks, rename });
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  it("undoes rename before an older clip edit and redoes both without rewriting old snapshots", async () => {
    await fixture(async ({ root, controller, journal, callbacks, rename }) => {
      await controller.recordEdit({ label: "Edit clip", kind: "timeline", files: { "index.html": { before: "original media/a.mov", after: "edited media/a.mov" } } });
      const originalEntry = structuredClone(controller.snapshot().state.undo[0]);
      await rename();
      const movedBytes = await readFile(join(root, "media/b.mov"));
      await controller.undo(callbacks);
      expect(await readFile(join(root, "media/a.mov"))).toEqual(movedBytes);
      expect(await readFile(join(root, "index.html"), "utf8")).toBe("edited media/a.mov");
      expect(controller.snapshot().state.undo[0]).toEqual(originalEntry);
      await controller.undo(callbacks);
      expect(await readFile(join(root, "index.html"), "utf8")).toBe("original media/a.mov");
      await controller.redo(callbacks);
      await controller.redo(callbacks);
      expect(await readFile(join(root, "media/b.mov"))).toEqual(movedBytes);
      expect(await readFile(join(root, "index.html"), "utf8")).toBe("edited media/b.mov");
      expect(await journal.listCommittedPendingHistory()).toEqual([]);
    });
  });

  it("rejects a changed binary before applying any undo snapshots or moving the stack", async () => {
    await fixture(async ({ root, controller, callbacks, rename }) => {
      await rename();
      const before = structuredClone(controller.snapshot().state);
      await writeFile(join(root, "media/b.mov"), "replacement source");
      await expect(controller.undo(callbacks)).rejects.toThrow();
      expect(await readFile(join(root, "index.html"), "utf8")).toBe("edited media/b.mov");
      expect(await readFile(join(root, "media/b.mov"), "utf8")).toBe("replacement source");
      expect(controller.snapshot().state).toEqual(before);
    });
  });

  it("atomically restores files when history storage fails, then acknowledges the compensated pair", async () => {
    await fixture(async ({ root, controller, journal, storage, callbacks, rename }) => {
      await rename();
      const save = storage.set;
      let rejectOnce = true;
      storage.set = async (projectId, state) => {
        if (rejectOnce) { rejectOnce = false; throw new Error("Storage full"); }
        await save(projectId, state);
      };
      await expect(controller.undo(callbacks)).rejects.toThrow("Storage full");
      expect(await readFile(join(root, "index.html"), "utf8")).toBe("edited media/b.mov");
      expect(await readFile(join(root, "media/b.mov"))).toHaveLength(6);
      expect(controller.snapshot().undoLabel).toBe("Rename media");
      expect(controller.snapshot().canRedo).toBe(false);
      expect(await journal.listCommittedPendingHistory()).toEqual([]);
      await controller.undo(callbacks);
      expect(await readFile(join(root, "media/a.mov"))).toHaveLength(6);
    });
  });

  it("recovers the stack after a process stops between an atomic move and history persistence", async () => {
    await fixture(async ({ root, controller, storage, journal, fetchImpl, callbacks, rename }) => {
      await rename();
      const entry = controller.snapshot().state.undo.at(-1)!;
      const replay: StudioHistoryTransactionInput = {
        files: [{ path: "index.html", expectedBefore: "edited media/b.mov", after: "edited media/a.mov" }],
        moves: entry.moves!.map(move => ({ ...move, from: move.to, to: move.from })),
        historyReplay: { entryId: entry.id, direction: "undo" },
      };
      await callbacks.applyTransaction(replay);
      const reloaded = await createPersistentEditHistoryController({ projectId: "demo", storage, onChange: () => {} });
      await reconcileDurableStudioFileTransactions({ projectId: "demo", fetchImpl, recordDurableEdit: reloaded.recordDurableEdit });
      expect(reloaded.snapshot().canUndo).toBe(false);
      expect(reloaded.snapshot().redoLabel).toBe("Rename media");
      expect(await readFile(join(root, "index.html"), "utf8")).toBe("edited media/a.mov");
      expect(await journal.listCommittedPendingHistory()).toEqual([]);
      await reloaded.redo(callbacks);
      expect(await readFile(join(root, "media/b.mov"))).toHaveLength(6);
    });
  });

  it("retains move-only delete history and restores the original binary on Undo", async () => {
    await fixture(async ({ root, controller, journal, fetchImpl, callbacks }) => {
      const bytes = await readFile(join(root, "media/a.mov"));
      const receipt = await journal.commit({ id: "delete-1", files: [], moves: [{ from: "media/a.mov", to: ".hyperframes/deleted-media/delete-1/a.mov", expectedVersion: createHash("sha256").update(bytes).digest("hex") }], history: { label: "Delete media", kind: "manual" } });
      await finalizeDurableStudioFileTransaction({ projectId: "demo", receipt, recordDurableEdit: controller.recordDurableEdit, fetchImpl });
      expect(controller.snapshot().canUndo).toBe(true);
      await controller.undo(callbacks);
      expect(await readFile(join(root, "media/a.mov"))).toEqual(bytes);
      await controller.redo(callbacks);
      expect(await readFile(join(root, ".hyperframes/deleted-media/delete-1/a.mov"))).toEqual(bytes);
    });
  });

  it("recovers both sides of a compensated replay when storage stayed unavailable", async () => {
    await fixture(async ({ root, controller, storage, journal, fetchImpl, callbacks, rename }) => {
      await rename();
      const save = storage.set;
      storage.set = async () => { throw new Error("Storage remains full"); };
      await expect(controller.undo(callbacks)).rejects.toThrow("Files were restored");
      expect(await readFile(join(root, "index.html"), "utf8")).toBe("edited media/b.mov");
      expect(await journal.listCommittedPendingHistory()).toHaveLength(2);
      storage.set = save;
      const reloaded = await createPersistentEditHistoryController({ projectId: "demo", storage, onChange: () => {} });
      await reconcileDurableStudioFileTransactions({ projectId: "demo", fetchImpl, recordDurableEdit: reloaded.recordDurableEdit });
      expect(reloaded.snapshot().undoLabel).toBe("Rename media");
      expect(reloaded.snapshot().canRedo).toBe(false);
      expect(await journal.listCommittedPendingHistory()).toEqual([]);
      expect(await readFile(join(root, "media/b.mov"))).toHaveLength(6);
    });
  });

  it("distinguishes an absent optional file from an empty file across undo and redo", async () => {
    await fixture(async ({ root, controller, journal, fetchImpl, callbacks }) => {
      await mkdir(join(root, ".studio"));
      const receipt = await journal.commit({ id: "create-empty", files: [{ path: ".studio/empty.json", expectedBefore: null, after: "" }], history: { label: "Create empty file", kind: "manual" } });
      await finalizeDurableStudioFileTransaction({ projectId: "demo", receipt, recordDurableEdit: controller.recordDurableEdit, fetchImpl });
      await controller.undo(callbacks);
      await expect(readFile(join(root, ".studio/empty.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await controller.redo(callbacks);
      expect(await readFile(join(root, ".studio/empty.json"), "utf8")).toBe("");
    });
  });

  it("keeps a completed undo visible and idempotent when receipt acknowledgement fails", async () => {
    await fixture(async ({ root, controller, journal, fetchImpl, callbacks, rename }) => {
      await rename();
      const appliedCallbacks = { ...callbacks, applyTransaction: async (input: StudioHistoryTransactionInput) => {
        const applied = await callbacks.applyTransaction(input);
        return { ...applied, acknowledge: async () => { throw new Error("ACK response lost"); } };
      } };
      await expect(controller.undo(appliedCallbacks)).resolves.toMatchObject({ ok: true, label: "Rename media" });
      expect(controller.snapshot().canUndo).toBe(false);
      expect(controller.snapshot().redoLabel).toBe("Rename media");
      expect(await readFile(join(root, "media/a.mov"))).toHaveLength(6);
      expect(await journal.listCommittedPendingHistory()).toHaveLength(1);
      await reconcileDurableStudioFileTransactions({ projectId: "demo", fetchImpl, recordDurableEdit: controller.recordDurableEdit });
      expect(controller.snapshot().canUndo).toBe(false);
      expect(controller.snapshot().redoLabel).toBe("Rename media");
      expect(await journal.listCommittedPendingHistory()).toEqual([]);
    });
  });
});
