import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEditHistoryEntry, createEmptyEditHistory, pushEditHistoryEntry } from "./editHistory";
import {
  createMemoryEditHistoryStorage,
  createIndexedDbEditHistoryStorage,
  loadEditHistoryState,
  saveEditHistoryState,
} from "./editHistoryStorage";

describe("edit history storage", () => {
  let storage: ReturnType<typeof createMemoryEditHistoryStorage>;

  beforeEach(() => {
    storage = createMemoryEditHistoryStorage();
  });

  it("returns empty history for projects without persisted state", async () => {
    const state = await loadEditHistoryState(storage, "project-1");

    expect(state).toEqual(createEmptyEditHistory());
  });

  it("saves and loads history per project", async () => {
    const entry = buildEditHistoryEntry({
      id: "entry-1",
      projectId: "project-1",
      label: "Move layer",
      files: { "index.html": { before: "a", after: "b" } },
      now: 100,
    });
    const state = pushEditHistoryEntry(createEmptyEditHistory(), entry);

    await saveEditHistoryState(storage, "project-1", state);

    expect(await loadEditHistoryState(storage, "project-1")).toEqual(state);
    expect(await loadEditHistoryState(storage, "project-2")).toEqual(createEmptyEditHistory());
  });

  it.each(["complete", "abort"])("waits for the IndexedDB transaction to %s after the write request succeeds", async outcome => {
    const request: { result: unknown; onsuccess?: () => void } = { result: "project-1" };
    const transaction: { objectStore: () => unknown; oncomplete?: () => void; onabort?: () => void; error?: Error } = { objectStore: () => ({ put: () => request }) };
    const close = vi.fn();
    const openRequest: { result: unknown; onsuccess?: () => void } = { result: { transaction: () => transaction, close } };
    vi.stubGlobal("indexedDB", { open: () => openRequest });
    try {
      let settled = false;
      const writing = createIndexedDbEditHistoryStorage().set("project-1", createEmptyEditHistory());
      const observed = writing.then(() => { settled = true; return "saved"; }, error => { settled = true; return error; });
      openRequest.onsuccess!();
      await Promise.resolve();
      request.onsuccess!();
      await Promise.resolve();
      expect(settled).toBe(false);
      if (outcome === "complete") {
        transaction.oncomplete!();
        expect(await observed).toBe("saved");
      } else {
        transaction.error = new Error("Storage aborted after request success");
        transaction.onabort!();
        expect(await observed).toBe(transaction.error);
      }
      expect(close).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});
