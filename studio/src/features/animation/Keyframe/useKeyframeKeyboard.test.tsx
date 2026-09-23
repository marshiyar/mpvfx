// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { usePlayerStore } from "../../../player/store/playerStore";
import { useKeyframeKeyboard } from "./useKeyframeKeyboard";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Host(props: Parameters<typeof useKeyframeKeyboard>[0]) {
  useKeyframeKeyboard(props);
  return null;
}

describe("useKeyframeKeyboard — keyframe retiming", () => {
  let mounted: { root: Root; host: HTMLElement } | null = null;

  const mount = (props: Partial<Parameters<typeof useKeyframeKeyboard>[0]> = {}) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <Host
          enabled
          onNudgeKeyframe={vi.fn()}
          {...props}
        />,
      ),
    );
    mounted = { root, host };
    return props.onNudgeKeyframe;
  };

  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => window.dispatchEvent(event));
    return event;
  };

  afterEach(() => {
    if (mounted) {
      act(() => mounted?.root.unmount());
      mounted.host.remove();
      mounted = null;
    }
    usePlayerStore.setState({ selectedKeyframes: new Set<string>() });
    document.body.replaceChildren();
  });

  it("nudges a selected keyframe one frame earlier with comma and later with period", () => {
    const onNudgeKeyframe = vi.fn();
    usePlayerStore.setState({ selectedKeyframes: new Set(["clip|x|move|50"]) });
    mount({ onNudgeKeyframe });

    const earlier = press(",");
    const later = press(".");

    expect(onNudgeKeyframe).toHaveBeenNthCalledWith(1, -1, false);
    expect(onNudgeKeyframe).toHaveBeenNthCalledWith(2, 1, false);
    expect(earlier.defaultPrevented).toBe(true);
    expect(later.defaultPrevented).toBe(true);
  });

  it("uses a coarse ten-frame nudge with Shift+comma or Shift+period", () => {
    const onNudgeKeyframe = vi.fn();
    usePlayerStore.setState({ selectedKeyframes: new Set(["clip|x|move|50"]) });
    mount({ onNudgeKeyframe });

    press(",", { shiftKey: true });
    press(".", { shiftKey: true });

    expect(onNudgeKeyframe).toHaveBeenNthCalledWith(1, -1, true);
    expect(onNudgeKeyframe).toHaveBeenNthCalledWith(2, 1, true);
  });

  it("leaves Left and Right for the playhead and canvas navigation", () => {
    const onNudgeKeyframe = vi.fn();
    usePlayerStore.setState({ selectedKeyframes: new Set(["clip|x|move|50"]) });
    mount({ onNudgeKeyframe });

    const left = press("ArrowLeft");
    const right = press("ArrowRight", { shiftKey: true });

    expect(onNudgeKeyframe).not.toHaveBeenCalled();
    expect(left.defaultPrevented).toBe(false);
    expect(right.defaultPrevented).toBe(false);
  });

  it("does not consume retiming keys without a selection, callback, or when typing", () => {
    const onNudgeKeyframe = vi.fn();
    mount({ onNudgeKeyframe });
    expect(press(",").defaultPrevented).toBe(false);
    expect(onNudgeKeyframe).not.toHaveBeenCalled();

    usePlayerStore.setState({ selectedKeyframes: new Set(["clip|x|move|50"]) });
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(press(".").defaultPrevented).toBe(false);
    expect(onNudgeKeyframe).not.toHaveBeenCalled();
  });

  it("does not shadow modified browser or system shortcuts", () => {
    const onNudgeKeyframe = vi.fn();
    usePlayerStore.setState({ selectedKeyframes: new Set(["clip|x|move|50"]) });
    mount({ onNudgeKeyframe });

    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      const event = press(".", init);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onNudgeKeyframe).not.toHaveBeenCalled();
  });

  it.each(["Delete", "Backspace", "ArrowLeft", "ArrowRight"])(
    "leaves %s to a focused application graph despite selected timeline keyframes",
    (key) => {
      const onDeleteKeyframe = vi.fn();
      const onNudgeKeyframe = vi.fn();
      usePlayerStore.setState({ selectedKeyframes: new Set(["clip|x|move|50"]) });
      mount({ onDeleteKeyframe, onNudgeKeyframe });
      const graph = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      graph.setAttribute("role", "application");
      graph.setAttribute("tabindex", "0");
      const point = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      graph.append(point);
      document.body.append(graph);
      const localKey = vi.fn();
      graph.addEventListener("keydown", localKey);
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      act(() => point.dispatchEvent(event));

      expect(localKey).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(false);
      expect(onDeleteKeyframe).not.toHaveBeenCalled();
      expect(onNudgeKeyframe).not.toHaveBeenCalled();
      expect([...usePlayerStore.getState().selectedKeyframes]).toEqual(["clip|x|move|50"]);
    },
  );

  it("preserves unrelated shortcuts from application graphs and Delete outside them", () => {
    const onAddKeyframe = vi.fn();
    const onDeleteKeyframe = vi.fn();
    usePlayerStore.setState({ selectedKeyframes: new Set(["clip|x|move|50"]) });
    mount({ onAddKeyframe, onDeleteKeyframe });
    const graph = document.body.appendChild(document.createElement("div"));
    graph.setAttribute("role", "application");
    const undo = new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    const localKey = vi.fn();
    graph.addEventListener("keydown", localKey);
    act(() => graph.dispatchEvent(undo));
    expect(localKey).toHaveBeenCalledOnce();
    expect(undo.defaultPrevented).toBe(false);
    act(() => graph.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true })));
    expect(onAddKeyframe).toHaveBeenCalledOnce();
    press("Delete");
    expect(onDeleteKeyframe).toHaveBeenCalledOnce();
  });
});
