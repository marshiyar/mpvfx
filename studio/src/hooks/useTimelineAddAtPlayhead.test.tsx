// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlayerStore } from "../player";
import { useTimelineAddAtPlayhead } from "./useTimelineAddAtPlayhead";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type AddCallbacks = ReturnType<typeof useTimelineAddAtPlayhead>;
type AddAtPlacement = (path: string, placement: { start: number; track: number }) => unknown;

function mountHook(addAsset: AddAtPlacement, addComposition: AddAtPlacement) {
  const host = document.createElement("div");
  const root = createRoot(host);
  let callbacks: AddCallbacks | null = null;

  function Harness() {
    callbacks = useTimelineAddAtPlayhead(addAsset, addComposition);
    return null;
  }

  act(() => root.render(<Harness />));
  return {
    callbacks: () => {
      if (!callbacks) throw new Error("hook did not mount");
      return callbacks;
    },
    unmount: () => act(() => root.unmount()),
  };
}

afterEach(() => {
  usePlayerStore.getState().reset();
});

describe("useTimelineAddAtPlayhead", () => {
  it("adds media to track zero at the live playhead", () => {
    const addAsset = vi.fn();
    const harness = mountHook(addAsset, vi.fn());
    usePlayerStore.getState().setCurrentTime(6.25);

    harness.callbacks().addAssetAtPlayhead("media/clip.mp4");

    expect(addAsset).toHaveBeenCalledWith("media/clip.mp4", { start: 6.25, track: 0 });
    harness.unmount();
  });

  it("adds compositions to track zero at the live playhead", () => {
    const addComposition = vi.fn();
    const harness = mountHook(vi.fn(), addComposition);
    usePlayerStore.getState().setCurrentTime(2.5);

    harness.callbacks().addCompositionAtPlayhead("compositions/title.html");

    expect(addComposition).toHaveBeenCalledWith("compositions/title.html", {
      start: 2.5,
      track: 0,
    });
    harness.unmount();
  });
});
