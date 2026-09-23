// @vitest-environment happy-dom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlatStyleSection } from "../../inspector/propertyPanelFlatStyleSections";
import { makeSelection, mountReactHarness } from "../domSelectionTestHarness";
import { useDomEditTextCommits } from "../useDomEditTextCommits";
import { getCuratedComputedStyles, getInlineStyles } from "../domEditingDom";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let unmount: (() => void) | undefined;
afterEach(() => { unmount?.(); document.body.replaceChildren(); });

function mountStylePanel(graded = false) {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const doc = iframe.contentDocument!;
  doc.body.innerHTML = '<video id="clip"></video><canvas id="__hf_color_grading_clip" data-hf-color-grading-canvas></canvas>';
  const element = doc.getElementById("clip")!;
  const picture = doc.querySelector("canvas")!;
  const redraw = vi.fn(() => { picture.style.opacity = element.getAttribute("data-hf-authored-opacity") || "1"; });
  if (graded) {
    element.setAttribute("data-hf-color-grading-source-hidden", "true");
    element.setAttribute("data-hf-authored-opacity", "0.8");
    element.style.setProperty("opacity", "0", "important");
    picture.style.opacity = "0.8";
    Object.assign(iframe.contentWindow!, { __hf: { colorGrading: { redraw } } });
  }
  const initial = { ...makeSelection("clip", element), tagName: "video", inlineStyles: getInlineStyles(element), computedStyles: getCuratedComputedStyles(element) };
  const persist = vi.fn().mockResolvedValue(undefined);
  let hook!: ReturnType<typeof useDomEditTextCommits>;
  function Panel() {
    const [selection, setSelection] = useState(initial);
    hook = useDomEditTextCommits({ projectId: "test", activeCompPath: "index.html", previewIframeRef: { current: iframe }, domEditSelection: selection,
      applyDomSelection: next => { if (next) setSelection(next); }, refreshDomEditSelectionFromPreview: vi.fn(), buildDomSelectionFromTarget: vi.fn(async () => null),
      persistDomEditOperations: persist, resolveImportedFontAsset: () => null, showToast: vi.fn() });
    return <FlatStyleSection projectId="test" element={selection} styles={selection.computedStyles} assets={[]} onSetStyle={hook.handleDomStyleCommit} onPreviewStyle={hook.handleDomStylePreview} />;
  }
  const root = mountReactHarness(<Panel />);
  unmount = () => act(() => root.unmount());
  const slider = (label: string) => {
    const track = document.querySelector<HTMLElement>(`[role="slider"][aria-label="${label}"]`)!;
    Object.defineProperty(track, "getBoundingClientRect", { value: () => ({ left: 0, width: 100, top: 0, height: 20 }) });
    return track;
  };
  const pointer = (track: HTMLElement, type: string, clientX: number) => act(() => {
    track.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX }));
    // happy-dom does not send Chromium's implicit capture-loss event on release.
    if (type === "pointerup") track.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 1 }));
  });
  return { element, picture, persist, slider, pointer, redraw, get hook() { return hook; } };
}

describe("style preview ownership through the live panel", () => {
  it("starts a second blur gesture from the saved 14px value and restores it on capture loss", async () => {
    const h = mountStylePanel();
    const track = h.slider("Layer blur");
    h.pointer(track, "pointerdown", 35);
    await act(async () => { h.pointer(track, "pointerup", 35); });
    expect(h.element.style.filter).toBe("blur(14px)");
    expect(h.persist).toHaveBeenCalledOnce();
    h.pointer(track, "pointerdown", 70);
    expect(h.element.style.filter).toBe("blur(28px)");
    h.pointer(track, "lostpointercapture", 70);
    h.pointer(track, "pointerup", 70);
    expect(h.element.style.filter).toBe("blur(14px)");
    expect(track.getAttribute("aria-valuenow")).toBe("14");
    expect(h.persist).toHaveBeenCalledOnce();
  });

  it("previews and saves the graded picture opacity while keeping the raw source hidden", async () => {
    const h = mountStylePanel(true);
    const track = h.slider("Opacity");
    h.pointer(track, "pointerdown", 35);
    expect(h.picture.style.opacity).toBe("0.35");
    expect(h.element.style.getPropertyValue("opacity")).toBe("0");
    expect(h.element.style.getPropertyPriority("opacity")).toBe("important");
    await act(async () => { h.pointer(track, "pointerup", 35); });
    expect(h.element.getAttribute("data-hf-authored-opacity")).toBe("0.35");
    h.pointer(track, "pointerdown", 60);
    expect(h.picture.style.opacity).toBe("0.6");
    act(() => { track.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })); });
    h.pointer(track, "pointerup", 60);
    expect(h.picture.style.opacity).toBe("0.35");
    expect(h.persist).toHaveBeenCalledOnce();
    h.persist.mockRejectedValueOnce(new Error("save failed"));
    h.pointer(track, "pointerdown", 65);
    await act(async () => { h.pointer(track, "pointerup", 65); });
    expect(h.picture.style.opacity).toBe("0.35");
    expect(h.element.style.getPropertyValue("opacity")).toBe("0");
    expect(h.element.style.getPropertyPriority("opacity")).toBe("important");
    expect(track.getAttribute("aria-valuenow")).toBe("35");
  });
});
