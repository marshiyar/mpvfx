// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import { mountReactHarness } from "../canvas/domSelectionTestHarness";
import { RemoteInspectorPanel } from "./RemoteInspectorPanel";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const selection: PreviewElementState = {
  handle: "e1", tag: "div", id: "card", className: "", text: "Hello", textEditable: false,
  rect: { x: 0, y: 0, width: 100, height: 50 }, visible: true, parent: null,
  sourceFile: "index.html", compositionPath: "index.html",
  dataAttributes: { "studio-clip-id": "clip" }, inlineStyles: {}, computedStyles: {},
};
afterEach(() => document.body.replaceChildren());

describe("remote inspector", () => {
  it("sends only a selected authored keyframe ease through the bounded callback", async () => {
    const loadGsap = vi.fn(async () => [{ id: "a1", label: "to #card", properties: { x: 40 },
      keyframes: [{ percentage: 0, properties: { x: 0 } },
        { percentage: 100, properties: { x: 40 } }] }]);
    const commitGsapKeyframe = vi.fn(async () => true);
    const root = mountReactHarness(<RemoteInspectorPanel selection={selection}
      loadGsap={loadGsap} commitGsap={vi.fn(async () => true)}
      commitGsapKeyframe={commitGsapKeyframe} />);
    const section = document.querySelector<HTMLElement>('[aria-label="Authored animations"]')!;
    const load = [...section.querySelectorAll("button")].find(button => button.textContent?.includes("Load"))!;
    await act(async () => { load.click(); });
    const position = document.querySelector<HTMLInputElement>('[aria-label="Keyframe position"]')!;
    const ease = document.querySelector<HTMLSelectElement>('[aria-label="Keyframe easing"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(position, "100");
      position.dispatchEvent(new Event("input", { bubbles: true }));
      ease.value = "power2.in";
      ease.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      [...section.querySelectorAll("button")].find(button => button.textContent === "Save keyframe easing")!.click();
    });
    expect(commitGsapKeyframe).toHaveBeenCalledWith(selection,
      { animationId: "a1", action: "ease", percentage: 100, ease: "power2.in" });
    act(() => root.unmount());
  });
  it("shows no destructive text editor without a proven leaf flag", () => {
    const root = mountReactHarness(<RemoteInspectorPanel selection={selection} commit={vi.fn(async () => true)} />);
    expect(document.querySelector('[aria-label="Text"]')).toBeNull();
    act(() => root.unmount());
  });

  it("submits bounded design edits and a distinct reset operation", async () => {
    const commit = vi.fn(async () => true);
    const root = mountReactHarness(<RemoteInspectorPanel selection={selection} commit={commit} />);
    const color = document.querySelector<HTMLInputElement>('[aria-label="Color"]')!;
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
      descriptor.set!.call(color, "#ff0000");
      color.dispatchEvent(new Event("input", { bubbles: true }));
      color.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(commit).toHaveBeenCalledWith(selection, [{ type: "inline-style", property: "color", value: "#ff0000" }], "Edit layer design");
    await act(async () => { document.querySelectorAll<HTMLButtonElement>("button")[1]!.click(); });
    expect(commit).toHaveBeenLastCalledWith(selection, "reset-design", "Reset design");
    act(() => root.unmount());
  });

  it("offers plain text only for a preview-agent verified leaf", async () => {
    const commit = vi.fn(async () => true);
    const leaf = { ...selection, textEditable: true };
    const root = mountReactHarness(<RemoteInspectorPanel selection={leaf} commit={commit} />);
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Text"]')!;
    expect(field).not.toBeNull();
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
      descriptor.set!.call(field, "Updated");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(commit).toHaveBeenCalledWith(leaf,
      [{ type: "text-content", property: "textContent", value: "Updated" }], "Edit layer design");
    act(() => root.unmount());
  });

  it("edits an existing numeric property on a source-bound authored animation", async () => {
    const loadGsap = vi.fn(async () => [{
      id: "tween-1", label: "to #card", properties: { x: 12, rotation: 30 },
    }]);
    const commitGsap = vi.fn(async () => true);
    const root = mountReactHarness(<RemoteInspectorPanel selection={selection}
      commit={vi.fn(async () => true)} loadGsap={loadGsap} commitGsap={commitGsap} />);
    const section = document.querySelector<HTMLElement>('[aria-label="Authored animations"]')!;
    await act(async () => {
      [...section.querySelectorAll("button")].find(button => button.textContent === "Load animations")!.click();
    });
    expect(loadGsap).toHaveBeenCalledWith(selection);
    expect(section.querySelector<HTMLSelectElement>('[aria-label="Animation"]')?.value).toBe("tween-1");
    expect(section.querySelector<HTMLSelectElement>('[aria-label="Animation property"]')?.value).toBe("x");
    const value = section.querySelector<HTMLInputElement>('[aria-label="Animation value"]')!;
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
      descriptor.set!.call(value, "18");
      value.dispatchEvent(new Event("input", { bubbles: true }));
      value.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      [...section.querySelectorAll("button")].find(button => button.textContent === "Save animation")!.click();
    });
    expect(commitGsap).toHaveBeenCalledWith(selection,
      { animationId: "tween-1", property: "x", value: 18 });
    act(() => root.unmount());
  });

  it("offers source-bound animations without native design writes in a legacy-only project", async () => {
    const loadGsap = vi.fn(async () => [{ id: "tween-1", label: "to #card", properties: { x: 12 } }]);
    const root = mountReactHarness(<RemoteInspectorPanel selection={selection}
      loadGsap={loadGsap} commitGsap={vi.fn(async () => true)} />);
    expect(document.querySelector('[aria-label="Text"]')).toBeNull();
    expect(document.querySelector('[aria-label="Color"]')).toBeNull();
    expect(document.querySelector('[aria-label="Authored animations"]')).not.toBeNull();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Authored animations"] button')!.click();
    });
    expect(loadGsap).toHaveBeenCalledWith(selection);
    act(() => root.unmount());
  });

  it("submits bounded fill, typography, and radius edits together", async () => {
    const commit = vi.fn(async () => true);
    const root = mountReactHarness(<RemoteInspectorPanel selection={selection} commit={commit} />);
    const background = document.querySelector<HTMLInputElement>('[aria-label="Background color"]')!;
    const radius = document.querySelector<HTMLInputElement>('[aria-label="Border radius"]')!;
    const weight = document.querySelector<HTMLSelectElement>('[aria-label="Font weight"]')!;
    const align = document.querySelector<HTMLSelectElement>('[aria-label="Text alignment"]')!;
    await act(async () => {
      const inputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      const selectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      inputValue.call(background, "#123456");
      background.dispatchEvent(new Event("input", { bubbles: true }));
      inputValue.call(radius, "12px");
      radius.dispatchEvent(new Event("input", { bubbles: true }));
      selectValue.call(weight, "700");
      weight.dispatchEvent(new Event("change", { bubbles: true }));
      selectValue.call(align, "center");
      align.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(commit).toHaveBeenCalledWith(selection, [
      { type: "inline-style", property: "background-color", value: "#123456" },
      { type: "inline-style", property: "font-weight", value: "700" },
      { type: "inline-style", property: "text-align", value: "center" },
      { type: "inline-style", property: "border-radius", value: "12px" },
    ], "Edit layer design");
    act(() => root.unmount());
  });

  it("routes saved native media mute and gain through the dedicated transaction callback", async () => {
    const commitMedia = vi.fn(async () => true);
    const nativeMedia = {
      clipId: "clip", assetKind: "video" as const, muted: false, gain: 1, playbackRate: 1,
      sourceStartSeconds: 0, startSeconds: 0, durationSeconds: 5,
      audioFxChain: null, audioAutomation: null,
    };
    const root = mountReactHarness(<RemoteInspectorPanel selection={selection}
      commit={vi.fn(async () => true)} nativeMedia={nativeMedia} commitMedia={commitMedia} />);
    const section = document.querySelector<HTMLElement>('[aria-label="Native media"]')!;
    await act(async () => {
      section.querySelector<HTMLInputElement>('[aria-label="Mute media"]')!.click();
    });
    expect(commitMedia).toHaveBeenCalledWith(selection, { kind: "muted", value: true });
    const gain = section.querySelector<HTMLInputElement>('[aria-label="Audio gain"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(gain, "1.25");
      gain.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      section.querySelector<HTMLButtonElement>('[aria-label="Save Audio gain"]')!.click();
    });
    expect(commitMedia).toHaveBeenLastCalledWith(selection, { kind: "gain", value: 1.25 });
    act(() => root.unmount());
  });

  it("adds a bounded simple GSAP tween and removes a loaded source-bound tween", async () => {
    const loadGsap = vi.fn(async () => [{ id: "tween-1", label: "to #card", properties: { x: 12 } }]);
    const commitGsapAnimation = vi.fn(async () => true);
    const root = mountReactHarness(<RemoteInspectorPanel selection={selection}
      loadGsap={loadGsap} commitGsap={vi.fn(async () => true)}
      commitGsapAnimation={commitGsapAnimation} />);
    const section = document.querySelector<HTMLElement>('[aria-label="Authored animations"]')!;
    const setInput = async (label: string, value: string) => {
      const field = section.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await setInput("New animation value", "20");
    await act(async () => {
      [...section.querySelectorAll("button")].find(button => button.textContent === "Add animation")!.click();
    });
    expect(commitGsapAnimation).toHaveBeenCalledWith(selection, {
      action: "add", method: "to", property: "x", value: 20, position: 0, duration: 1,
    });
    await act(async () => {
      [...section.querySelectorAll("button")].find(button => button.textContent === "Remove animation")!.click();
    });
    expect(commitGsapAnimation).toHaveBeenLastCalledWith(selection,
      { action: "remove", animationId: "tween-1" });
    act(() => root.unmount());
  });

  it("exposes a verified fromTo start value and flat easing", async () => {
    const loadGsap = vi.fn(async () => [{ id: "tween-1", label: "fromTo #card", method: "fromTo" as const,
      properties: { x: 40 }, fromProperties: { x: 10 }, ease: "none" }]);
    const commitGsap = vi.fn(async () => true);
    const commitGsapAnimation = vi.fn(async () => true);
    const root = mountReactHarness(<RemoteInspectorPanel selection={selection}
      loadGsap={loadGsap} commitGsap={commitGsap} commitGsapAnimation={commitGsapAnimation} />);
    const section = document.querySelector<HTMLElement>('[aria-label="Authored animations"]')!;
    await act(async () => { section.querySelector<HTMLButtonElement>("button")!.click(); });
    const from = section.querySelector<HTMLInputElement>('[aria-label="Animation from value"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(from, "20");
      from.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { [...section.querySelectorAll("button")]
      .find(button => button.textContent === "Save from value")!.click(); });
    expect(commitGsap).toHaveBeenCalledWith(selection,
      { animationId: "tween-1", property: "x", value: 20, endpoint: "from" });
    const ease = section.querySelector<HTMLSelectElement>('[aria-label="Animation easing"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(ease, "sine.in");
      ease.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { [...section.querySelectorAll("button")]
      .find(button => button.textContent === "Save easing")!.click(); });
    expect(commitGsapAnimation).toHaveBeenCalledWith(selection,
      { action: "ease", animationId: "tween-1", ease: "sine.in" });
    act(() => root.unmount());
  });

  it("edits a source-bound motion point without offering a scalar value field", async () => {
    const points = [{ x: 0, y: 0 }, { x: 20, y: 30 }, { x: 40, y: 0 }];
    const loadGsap = vi.fn(async () => [{ id: "path-1", label: "to #card", method: "to" as const,
      properties: {}, motionPath: { points, curviness: 1, autoRotate: false, isCubic: false } }]);
    const commitGsapAnimation = vi.fn(async () => true);
    const root = mountReactHarness(<RemoteInspectorPanel selection={selection}
      loadGsap={loadGsap} commitGsap={vi.fn(async () => true)}
      commitGsapAnimation={commitGsapAnimation} />);
    const section = document.querySelector<HTMLElement>('[aria-label="Authored animations"]')!;
    await act(async () => { section.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(section.querySelector('[aria-label="Animation value"]')).toBeNull();
    const point = section.querySelector<HTMLSelectElement>('[aria-label="Motion path point"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(point, "1");
      point.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const y = section.querySelector<HTMLInputElement>('[aria-label="Motion path point Y"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(y, "35");
      y.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { [...section.querySelectorAll("button")]
      .find(button => button.textContent === "Save motion point")!.click(); });
    expect(commitGsapAnimation).toHaveBeenCalledWith(selection,
      { action: "motion-point", animationId: "path-1", index: 1, x: 20, y: 35 });
    act(() => root.unmount());
  });

  it("submits only bounded visual fields through the source transaction", async () => {
    const commit = vi.fn(async () => true);
    const root = mountReactHarness(<RemoteInspectorPanel selection={selection} commit={commit} />);
    const border = document.querySelector<HTMLInputElement>('[aria-label="Border color"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(border, "#abcdef");
      border.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Visual style"] button')!.click();
    });
    expect(commit).toHaveBeenCalledWith(selection,
      [{ type: "inline-style", property: "border-color", value: "#abcdef" }], "Edit visual style");
    act(() => root.unmount());
  });

  it("offers legacy video grading presets only when the source-only callback is provided", async () => {
    const video = { ...selection, tag: "video" };
    const commitLegacyGrade = vi.fn(async () => true);
    const root = mountReactHarness(<RemoteInspectorPanel selection={video}
      commitLegacyGrade={commitLegacyGrade} />);
    const preset = document.querySelector<HTMLSelectElement>('[aria-label="Grade preset"]')!;
    expect(preset).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(preset, "warm-daylight");
      preset.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Legacy color grade"] button')!.click();
    });
    expect(commitLegacyGrade).toHaveBeenCalledWith(video, "warm-daylight");
    act(() => root.unmount());
    const nativeRoot = mountReactHarness(<RemoteInspectorPanel selection={video} />);
    expect(document.querySelector('[aria-label="Grade preset"]')).toBeNull();
    act(() => nativeRoot.unmount());
  });
});
