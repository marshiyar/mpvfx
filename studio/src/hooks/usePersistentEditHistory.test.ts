import { describe, expect, it, vi } from "vitest";
import { createEmptyEditHistory } from "../utils/editHistory";
import type { EditHistoryStorageAdapter } from "../utils/editHistoryStorage";
import { createMemoryEditHistoryStorage } from "../utils/editHistoryStorage";
import {
  serializeStudioFileMutation,
  serializeStudioFileMutations,
} from "../utils/studioFileMutationCoordinator";
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
