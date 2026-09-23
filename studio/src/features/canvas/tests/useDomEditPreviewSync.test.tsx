// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installReactActEnvironment, makeSelection } from "../domSelectionTestHarness";
import type { DomEditSelection } from "../domEditing";
import { useDomEditPreviewSync } from "../useDomEditPreviewSync";

vi.mock("../manualEdits", () => ({ reapplyPositionEditsAfterSeek: vi.fn() }));
installReactActEnvironment();

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); });

function harness() {
  const iframe = document.createElement("iframe");
  // Own load events explicitly; attaching an empty Happy DOM iframe schedules
  // an unrelated about:blank load in the middle of deferred assertions.
  const doc = document.implementation.createHTMLDocument("preview");
  Object.defineProperty(iframe, "contentDocument", { configurable: true, value: doc });
  doc.body.innerHTML = '<div id="a"></div><div id="b"></div>';
  const initial = makeSelection("A", doc.getElementById("a")!);
  const other = makeSelection("B", doc.getElementById("b")!);
  const selectionRef = { current: initial as DomEditSelection | null };
  const groupRef = { current: [initial] };
  const requests: Array<(selection: DomEditSelection | null) => void> = [];
  const apply = vi.fn((selection: DomEditSelection | null) => {
    selectionRef.current = selection;
  });
  const params = {
    previewIframe: iframe,
    activeCompPath: "index.html",
    captionEditMode: false,
    domEditSelectionRef: selectionRef,
    domEditGroupSelectionsRef: groupRef,
    domEditSelection: initial,
    refreshDomEditGroupSelectionsFromPreview: vi.fn(async () => {}),
    applyDomSelection: apply,
    buildDomSelectionFromTarget: vi.fn(() => new Promise<DomEditSelection | null>(resolve => {
      requests.push(resolve);
    })),
    refreshPreviewDocumentVersion: vi.fn(),
    syncPreviewHotkeys: vi.fn(),
    applyStudioManualEditsToPreviewRef: { current: vi.fn(async () => {}) },
    gsapCacheVersion: 0,
  };
  function Probe() { useDomEditPreviewSync(params); return null; }
  const host = document.createElement("div");
  let root: Root | null = createRoot(host);
  const render = () => act(() => root!.render(<Probe />));
  const unmount = () => { if (root) act(() => root!.unmount()); root = null; };
  cleanups.push(() => { unmount(); iframe.remove(); host.remove(); });
  render();
  return { iframe, doc, params, initial, other, apply, selectionRef, groupRef, requests, render, unmount };
}

describe("preview selection refresh ownership", () => {
  it("applies a completed refresh while the same selection still owns the document", async () => {
    const h = harness();
    const refreshed = { ...h.initial, textContent: "updated" };
    await act(async () => { h.requests[0](refreshed); });
    expect(h.apply).toHaveBeenCalledWith(refreshed, { revealPanel: false, preserveGroup: true });
  });

  it("does not restore an old selection after the user selects another clip", async () => {
    const h = harness();
    h.selectionRef.current = h.other;
    h.groupRef.current = [h.other];
    await act(async () => { h.requests[0](h.initial); });
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.selectionRef.current).toBe(h.other);
  });

  it("does not resurrect a cleared selection", async () => {
    const h = harness();
    h.selectionRef.current = null;
    h.groupRef.current = [];
    await act(async () => { h.requests[0](h.initial); });
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("drops a refresh started before composition navigation", async () => {
    const h = harness();
    h.params.activeCompPath = "other.html";
    h.render();
    h.apply.mockClear();
    await act(async () => { h.requests[0](h.initial); });
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("drops a refresh after the preview document has been replaced", async () => {
    const h = harness();
    Object.defineProperty(h.iframe, "contentDocument", {
      configurable: true,
      value: document.implementation.createHTMLDocument("replacement"),
    });
    await act(async () => { h.requests[0](h.initial); });
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("drops an older load refresh when a newer load refresh has started", async () => {
    const h = harness();
    act(() => h.iframe.dispatchEvent(new Event("load")));
    await act(async () => { h.requests[0](h.initial); });
    expect(h.apply).not.toHaveBeenCalled();
    await act(async () => { h.requests[1]({ ...h.initial, textContent: "new" }); });
    expect(h.apply).toHaveBeenCalledOnce();
  });

  it("does not publish a selection after unmount", async () => {
    const h = harness();
    h.unmount();
    await act(async () => { h.requests[0](h.initial); });
    expect(h.apply).not.toHaveBeenCalled();
  });
});
