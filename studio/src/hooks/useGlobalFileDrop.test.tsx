// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { usePlayerStore } from "../player";
import { useGlobalFileDrop } from "./useStudioContextValue";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
  usePlayerStore.setState({ currentTime: 0 });
});

it("keeps OS file drops placing media at the current playhead without a visual overlay", () => {
  const handleTimelineFileDrop = vi.fn(async () => {});
  let handlers: ReturnType<typeof useGlobalFileDrop> | null = null;
  const host = document.createElement("div");
  const root = createRoot(host);

  function Harness() {
    handlers = useGlobalFileDrop(handleTimelineFileDrop);
    return null;
  }

  act(() => {
    usePlayerStore.setState({ currentTime: 7.25 });
    root.render(<Harness />);
  });

  const media = new File(["video"], "clip.mp4", { type: "video/mp4" });
  const preventDefault = vi.fn();
  const files = Object.assign([media], { item: (index: number) => [media][index] ?? null });

  act(() => {
    handlers!.onDragOver({
      dataTransfer: { types: ["Files"] },
      preventDefault,
    } as unknown as React.DragEvent);
    handlers!.onDrop({
      defaultPrevented: false,
      dataTransfer: { files },
      preventDefault,
    } as unknown as React.DragEvent);
  });

  expect(preventDefault).toHaveBeenCalledTimes(2);
  expect(handleTimelineFileDrop).toHaveBeenCalledWith([media], { start: 7.25, track: 0 });
  act(() => root.unmount());
});
