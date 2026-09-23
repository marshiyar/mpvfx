// @vitest-environment happy-dom

import React, { act, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "../../features/canvas/domEditing";
import type { LeftSidebarHandle } from "../../features/media/LeftSidebar";
import { usePlayerStore } from "../../player/store/playerStore";
import { useAppHotkeys } from "../useAppHotkeys";
import { mountReactHarness } from "../../features/canvas/domSelectionTestHarness";
import { ColorCurves, type ColorCurveValues } from "../../features/inspector/propertyPanelColorCurves";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const domDelete = vi.fn(async () => undefined);
const undo = vi.fn(async () => ({ ok: false }));
const redo = vi.fn(async () => ({ ok: false }));
const curveCommit = vi.fn();
let root: Root | null = null;
let sync: ((iframe: HTMLIFrameElement | null) => void) | null = null;

function selection(): DomEditSelection {
  const element = document.createElement("section");
  element.id = "card";
  return {
    element,
    id: "card",
    selector: "#card",
    selectorIndex: 0,
    sourceFile: "index.html",
  } as unknown as DomEditSelection;
}

function Harness({ curves = false }: { curves?: boolean }) {
  const [curveValue, setCurveValue] = useState<ColorCurveValues>({
    curves: { master: [[0, 0], [0.5, 0.5], [1, 1]], red: [[0, 0], [1, 1]], green: [[0, 0], [1, 1]], blue: [[0, 0], [1, 1]] },
    hueCurves: { hueVsHue: [], hueVsSaturation: [], hueVsLuma: [] },
  });
  const selectionRef = useRef<DomEditSelection | null>(selection());
  const hotkeys = useAppHotkeys({
    handleTimelineElementsDelete: vi.fn(async () => undefined),
    handleTimelineElementSplit: vi.fn(async () => undefined),
    handleDomEditElementDelete: domDelete,
    domEditSelectionRef: selectionRef,
    clearDomSelectionRef: useRef<() => void>(() => undefined),
    editHistory: {
      undo,
      redo,
      state: { undo: [], redo: [] },
    },
    readOptionalProjectFile: vi.fn(async () => ""),
    readProjectFile: vi.fn(async () => ""),
    writeProjectFile: vi.fn(async () => undefined),
    domEditSaveTimestampRef: useRef(0),
    showToast: vi.fn(),
    syncHistoryPreviewAfterApply: vi.fn(async () => undefined),
    waitForPendingDomEditSaves: vi.fn(async () => undefined),
    leftSidebarRef: useRef<LeftSidebarHandle | null>(null),
    handleCopy: vi.fn(() => false),
    handlePaste: vi.fn(() => false),
    handleCut: vi.fn(() => false),
    onResetKeyframes: vi.fn(() => false),
    onDeleteSelectedKeyframes: vi.fn(),
    onAfterUndoRedo: vi.fn(),
  } as unknown as Parameters<typeof useAppHotkeys>[0]);
  sync = hotkeys.syncPreviewHotkeys;
  return curves ? <ColorCurves value={curveValue} onPreview={() => undefined} onCommit={(next) => {
    curveCommit(next);
    setCurveValue(next);
  }} /> : null;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  usePlayerStore.getState().reset();
  domDelete.mockClear();
  undo.mockClear();
  redo.mockClear();
  curveCommit.mockClear();
});

describe("preview iframe hotkey forwarding", () => {
  it.each(["Delete", "Backspace"])("leaves %s to the focused curve without deleting its clip", (key) => {
    root = mountReactHarness(<Harness curves />);
    const graph = document.querySelector('[data-color-curve-graph="master"]');
    if (!graph) throw new Error("Expected Master curve");
    act(() => graph.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    act(() => graph.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    expect(domDelete).not.toHaveBeenCalled();
    expect(curveCommit).toHaveBeenCalledOnce();
    expect(curveCommit.mock.calls[0][0].curves.master).toHaveLength(2);
    // Keeping the focused SVG mounted is essential: native key repeats target
    // document.body after a remount, where Delete would own the whole clip.
    expect(document.querySelector('[data-color-curve-graph="master"]')).toBe(graph);
    act(() => graph.dispatchEvent(new KeyboardEvent("keydown", { key, repeat: true, bubbles: true, cancelable: true })));
    expect(curveCommit).toHaveBeenCalledOnce();
    expect(domDelete).not.toHaveBeenCalled();

    act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    expect(domDelete).toHaveBeenCalledOnce();
  });

  it("keeps curve endpoint and empty selection Delete scoped too", () => {
    root = mountReactHarness(<Harness curves />);
    const graph = document.querySelector('[data-color-curve-graph="master"]');
    if (!graph) throw new Error("Expected Master curve");
    for (const key of ["Delete", "Home", "Delete", "End", "Backspace"]) {
      act(() => graph.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    }
    expect(domDelete).not.toHaveBeenCalled();
    expect(curveCommit).not.toHaveBeenCalled();
  });

  it("still allows command Undo while the curve has focus", async () => {
    root = mountReactHarness(<Harness curves />);
    const graph = document.querySelector('[data-color-curve-graph="master"]');
    if (!graph) throw new Error("Expected Master curve");
    await act(async () => graph.dispatchEvent(new KeyboardEvent("keydown", {
      key: "z", metaKey: true, bubbles: true, cancelable: true,
    })));
    expect(undo).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "Undo", key: "z", shiftKey: false, metaKey: true, ctrlKey: false },
    { name: "Redo", key: "z", shiftKey: true, metaKey: true, ctrlKey: false },
    { name: "Redo", key: "y", shiftKey: false, metaKey: false, ctrlKey: true },
  ])("dispatches $name only once for one preview keypress", async (shortcut) => {
    root = mountReactHarness(<Harness />);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    act(() => { sync?.(iframe); sync?.(iframe); });
    const inner = iframe.contentWindow as (Window & typeof globalThis) | null;
    if (!inner) throw new Error("expected an iframe window");

    await act(async () => inner.document.body.dispatchEvent(new inner.KeyboardEvent("keydown", {
      ...shortcut, bubbles: true, cancelable: true,
    })));

    expect(shortcut.name === "Undo" ? undo : redo).toHaveBeenCalledTimes(1);
    expect(shortcut.name === "Undo" ? redo : undo).not.toHaveBeenCalled();
  });

  it("removes capture listeners from the previously attached preview", () => {
    root = mountReactHarness(<Harness />);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    act(() => sync?.(iframe));
    const inner = iframe.contentWindow as (Window & typeof globalThis) | null;
    if (!inner) throw new Error("expected an iframe window");
    act(() => sync?.(null));

    act(() => inner.document.body.dispatchEvent(new inner.KeyboardEvent("keydown", {
      key: "Delete", bubbles: true, cancelable: true,
    })));

    expect(domDelete).not.toHaveBeenCalled();
  });

  it("still delivers Delete after the preview reloads", () => {
    // A reload keeps the iframe element (no ref callback) and the same
    // WindowProxy (an identity check sees no change) but replaces the window
    // holding the listeners. Attaching once left Delete dead inside the canvas
    // after the first reload — and clicking the canvas is what puts focus there.
    root = mountReactHarness(<Harness />);

    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    act(() => sync?.(iframe));

    // The reload: same element, a window that has lost its listeners.
    act(() => sync?.(iframe));

    const inner = iframe.contentWindow as (Window & typeof globalThis) | null;
    if (!inner) throw new Error("expected an iframe window");
    inner.document.body.dispatchEvent(
      new inner.KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );

    expect(domDelete).toHaveBeenCalledTimes(1);
  });
});
