// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppHotkeys } from "../useAppHotkeys";
import { usePlayerStore } from "../../player/store/playerStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Options = Parameters<typeof useAppHotkeys>[0];
const restored = {
  ok: true, label: "Move", paths: ["index.html"],
  files: { "index.html": { previous: "after", restored: "before" } },
};

async function harness(overrides: Partial<Options> = {}) {
  const options: Options = {
    projectId: "project-a", activeCompPath: "index.html",
    handleTimelineElementsDelete: vi.fn(async () => {}),
    handleTimelineElementSplit: vi.fn(async () => {}),
    handleDomEditElementDelete: vi.fn(async () => {}),
    domEditSelectionRef: { current: null }, clearDomSelectionRef: { current: () => {} },
    editHistory: { undo: vi.fn(async () => restored), redo: vi.fn(async () => restored), state: { undo: [], redo: [] } },
    readOptionalProjectFile: vi.fn(async () => ""), readProjectFile: vi.fn(async () => ""),
    writeProjectFile: vi.fn(async () => {}), domEditSaveTimestampRef: { current: 0 },
    showToast: vi.fn(), syncHistoryPreviewAfterApply: vi.fn(async () => {}),
    waitForPendingDomEditSaves: vi.fn(async () => {}), leftSidebarRef: { current: null },
    handleCopy: () => false, handlePaste: async () => {}, handleCut: async () => false,
    onResetKeyframes: () => false, onDeleteSelectedKeyframes: () => {},
    onAfterUndoRedo: vi.fn(), forceReloadSdkSession: vi.fn(), ...overrides,
  };
  let hotkeys!: ReturnType<typeof useAppHotkeys>;
  function Probe() { hotkeys = useAppHotkeys(options); return null; }
  const root = createRoot(document.createElement("div"));
  let mounted = true;
  await act(async () => root.render(<Probe />));
  return {
    options, get hotkeys() { return hotkeys; },
    rerender: async (next: Partial<Options>) => {
      Object.assign(options, next);
      await act(async () => root.render(<Probe />));
    },
    unmount: async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } },
  };
}

afterEach(() => usePlayerStore.getState().reset());

describe("Undo/Redo preview ownership", () => {
  it.each(["project", "composition", "unmount"] as const)(
    "does not start a deferred Undo after its %s changes",
    async (boundary) => {
      const drain = deferred<void>();
      const h = await harness({ waitForPendingDomEditSaves: () => drain.promise });
      try {
        const pending = h.hotkeys.handleUndo();
        if (boundary === "project") await h.rerender({ projectId: "project-b" });
        else if (boundary === "composition") await h.rerender({ activeCompPath: "nested.html" });
        else await h.unmount();
        await act(async () => { drain.resolve(); await pending; });

        expect(h.options.editHistory.undo).not.toHaveBeenCalled();
        expect(h.options.syncHistoryPreviewAfterApply).not.toHaveBeenCalled();
        expect(h.options.showToast).not.toHaveBeenCalled();
      } finally { await h.unmount(); }
    },
  );

  it.each(["project", "composition", "unmount"] as const)(
    "does not apply completed history to a different %s",
    async (boundary) => {
      const applied = deferred<typeof restored>();
      const undo = vi.fn(() => applied.promise);
      const h = await harness({ editHistory: { undo, redo: undo, state: { undo: [], redo: [] } } });
      try {
        let pending!: Promise<void>;
        await act(async () => { pending = h.hotkeys.handleUndo(); });
        expect(undo).toHaveBeenCalledOnce();
        if (boundary === "project") await h.rerender({ projectId: "project-b" });
        else if (boundary === "composition") await h.rerender({ activeCompPath: "nested.html" });
        else await h.unmount();
        await act(async () => { applied.resolve(restored); await pending; });

        expect(h.options.onAfterUndoRedo).not.toHaveBeenCalled();
        expect(h.options.forceReloadSdkSession).not.toHaveBeenCalled();
        expect(h.options.syncHistoryPreviewAfterApply).not.toHaveBeenCalled();
        expect(h.options.showToast).not.toHaveBeenCalled();
      } finally { await h.unmount(); }
    },
  );

  it("still applies and announces completed history in the current composition", async () => {
    const h = await harness();
    try {
      await act(async () => h.hotkeys.handleRedo());
      expect(h.options.editHistory.redo).toHaveBeenCalledOnce();
      expect(h.options.onAfterUndoRedo).toHaveBeenCalledOnce();
      expect(h.options.forceReloadSdkSession).toHaveBeenCalledOnce();
      expect(h.options.syncHistoryPreviewAfterApply).toHaveBeenCalledWith({ paths: restored.paths, files: restored.files });
      expect(h.options.showToast).toHaveBeenCalledWith("Redid Move", "info");
    } finally { await h.unmount(); }
  });
});
