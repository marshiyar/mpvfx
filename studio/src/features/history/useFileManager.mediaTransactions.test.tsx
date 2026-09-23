// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeStudioFileMutations } from "./studioFileMutationCoordinator";
import type { DurableRecordEditInput } from "./usePersistentEditHistory";

const tree = vi.hoisted(() => ({ refresh: vi.fn(async () => {}) }));
vi.mock("./useFileTree", () => ({
  useFileTree: () => ({
    projectDir: "", fileTree: ["index.html", "media/a.mov"], fileTreeLoaded: true,
    refreshFileTree: tree.refresh, removeProjectPath: vi.fn(),
    compositions: ["index.html"], assets: ["media/a.mov"], fontAssets: [],
  }),
}));
import { useFileManager } from "./useFileManager";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mounted: Root[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function receipt(id: string, deleting = false) {
  return {
    id, state: "COMMITTED", sequence: 1,
    files: deleting ? [] : [{ path: "index.html", expectedBefore: "media/a.mov", after: "media/b.mov" }],
    moves: [{ from: "media/a.mov", to: deleting ? `.hyperframes/deleted-media/${id}/a.mov` : "media/b.mov", expectedVersion: "a".repeat(64) }],
    history: { label: deleting ? "Delete media" : "Rename media", kind: "manual" },
  };
}
async function mount(recordDurableEdit = vi.fn(async (_input: DurableRecordEditInput) => {})) {
  const captured: { manager: ReturnType<typeof useFileManager> | null } = { manager: null };
  const showToast = vi.fn();
  const setRefreshKey = vi.fn();
  function Probe({ projectId }: { projectId: string }) {
    captured.manager = useFileManager({ projectId, recordDurableEdit, showToast, setRefreshKey });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  mounted.push(root);
  await act(async () => root.render(<Probe projectId="a" />));
  return {
    get manager() { return captured.manager!; }, recordDurableEdit, showToast, setRefreshKey,
    switchProject: async () => { await act(async () => root.render(<Probe projectId="b" />)); },
  };
}
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => root.unmount());
  tree.refresh.mockReset().mockResolvedValue(undefined);
  vi.unstubAllGlobals();
});

describe("media rename/delete durable receipts", () => {
  it.each(["rename", "delete"])("persists %s history before acknowledging or refreshing", async operation => {
    const events: string[] = [];
    const storage = deferred<void>();
    const recorder = vi.fn(async (_input: DurableRecordEditInput) => {
      events.push("history:start"); await storage.promise; events.push("history:stored");
    });
    tree.refresh.mockImplementation(async () => { events.push("refresh"); });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" || init?.method === "DELETE") {
        events.push("mutation");
        const payload = JSON.parse(String(init.body));
        return Response.json({ ok: true, receipt: receipt(payload.transactionId, operation === "delete") });
      }
      events.push("ack");
      return Response.json({ ok: true });
    }));
    const probe = await mount(recorder);
    let pending!: Promise<void>;
    await act(async () => {
      pending = operation === "rename" ? probe.manager.handleRenameFile("media/a.mov", "media/b.mov") : probe.manager.handleDeleteFile("media/a.mov");
    });
    await vi.waitFor(() => expect(recorder).toHaveBeenCalledOnce());
    expect(events).toEqual(["mutation", "history:start"]);
    expect(probe.setRefreshKey).not.toHaveBeenCalled();
    storage.resolve();
    await act(async () => pending);
    expect(events).toEqual(["mutation", "history:start", "history:stored", "ack", "refresh"]);
    expect(recorder.mock.calls[0]![0].moves).toHaveLength(1);
    expect(probe.setRefreshKey).toHaveBeenCalledOnce();
  });

  it("recovers a lost operation response by the same receipt ID without resubmitting", async () => {
    let transactionId = "";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        transactionId = JSON.parse(String(init.body)).transactionId;
        throw new Error("IPC response lost");
      }
      if (url.endsWith("/acknowledge")) return Response.json({ ok: true });
      expect(url).toBe(`/api/projects/a/file-transactions/${transactionId}`);
      return Response.json(receipt(transactionId));
    });
    vi.stubGlobal("fetch", fetchMock);
    const probe = await mount();
    await act(async () => probe.manager.handleRenameFile("media/a.mov", "media/b.mov"));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(probe.recordDurableEdit).toHaveBeenCalledWith(expect.objectContaining({ durableTransactionIds: [transactionId] }));
    expect(probe.showToast).not.toHaveBeenCalled();
  });

  it("leaves a late project-A receipt pending without touching project B", async () => {
    const response = deferred<Response>();
    let transactionId = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      transactionId = JSON.parse(String(init?.body)).transactionId;
      return response.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const probe = await mount();
    let pending!: Promise<void>;
    await act(async () => { pending = probe.manager.handleRenameFile("media/a.mov", "media/b.mov"); });
    await vi.waitFor(() => expect(transactionId).not.toBe(""));
    await probe.switchProject();
    await act(async () => {
      probe.manager.setEditingFile({ path: "media/a.mov", content: "B file" });
      response.resolve(Response.json({ ok: true, receipt: receipt(transactionId) }));
      await pending;
    });
    expect(probe.manager.editingFile).toEqual({ path: "media/a.mov", content: "B file" });
    expect(probe.recordDurableEdit).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tree.refresh).not.toHaveBeenCalled();
    expect(probe.setRefreshKey).not.toHaveBeenCalled();
    expect(probe.showToast).not.toHaveBeenCalled();
  });

  it("does not refresh project B when project A's library refresh finishes late", async () => {
    const refresh = deferred<void>();
    tree.refresh.mockReturnValue(refresh.promise);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Response.json({ ok: true, receipt: receipt(JSON.parse(String(init.body)).transactionId, true) });
      return Response.json({ ok: true });
    }));
    const probe = await mount();
    let pending!: Promise<void>;
    await act(async () => { pending = probe.manager.handleDeleteFile("media/a.mov"); });
    await vi.waitFor(() => expect(tree.refresh).toHaveBeenCalledOnce());
    await probe.switchProject();
    refresh.resolve();
    await act(async () => pending);
    expect(probe.setRefreshKey).not.toHaveBeenCalled();
  });

  it("cancels a queued operation after switching projects before it acquires the file lock", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const probe = await mount();
    const locked = deferred<void>();
    const started = deferred<void>();
    const held = serializeStudioFileMutations(probe.manager.writeProjectFile, ["index.html"], async () => { started.resolve(); await locked.promise; });
    await started.promise;
    const pending = probe.manager.handleDeleteFile("media/a.mov");
    await probe.switchProject();
    locked.resolve();
    await act(async () => { await held; await pending; });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(probe.recordDurableEdit).not.toHaveBeenCalled();
    expect(probe.showToast).not.toHaveBeenCalled();
  });
});
