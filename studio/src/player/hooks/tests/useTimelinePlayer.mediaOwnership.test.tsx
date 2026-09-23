// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimelinePlayer } from "../useTimelinePlayer";
import { usePlayerStore, type TimelineElement } from "../../store/playerStore";

const harness = vi.hoisted(() => ({
  sync: null as null | ((elements: TimelineElement[]) => void),
  complete: null as null | (() => void),
}));
vi.mock("../useTimelineSyncCallbacks", () => ({
  useTimelineSyncCallbacks: (options: { syncTimelineElements: typeof harness.sync }) => {
    harness.sync = options.syncTimelineElements;
    return {
      processTimelineMessageRef: { current: () => {} },
      enrichMissingCompositionsRef: { current: () => {} },
      onIframeLoad: () => {},
    };
  },
}));
vi.mock("../../lib/mediaProbe", () => ({
  applyCachedSourceDurations: (elements: TimelineElement[]) => elements,
  probeMissingSourceDurations: async (
    elements: TimelineElement[],
    projectId: string,
    apply: (...args: unknown[]) => void,
  ) => {
    const element = elements[0];
    harness.complete = () =>
      apply(element.key ?? element.id, 11, {
        projectId,
        source: element.src,
        tag: element.tag,
      });
  },
  matchesMediaProbeSource: (source: string, target: { source: string }) => source === target.source,
}));
let root: Root;
const clip: TimelineElement = {
  id: "clip",
  key: "index.html::clip",
  tag: "video",
  src: "assets/a.mp4",
  start: 0,
  duration: 4,
  track: 0,
};
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  usePlayerStore.getState().reset();
  usePlayerStore.setState({ timelineProjectId: "a", timelineSessionEpoch: 1 });
  root = createRoot(document.createElement("div"));
  function Probe() {
    useTimelinePlayer();
    return null;
  }
  act(() => root.render(<Probe />));
  act(() => harness.sync?.([{ ...clip }]));
});
afterEach(() => {
  act(() => root.unmount());
  usePlayerStore.getState().reset();
});

describe("metadata result ownership", () => {
  it.each([
    ["a different project", { timelineProjectId: "b" }],
    ["a reopened session", { timelineSessionEpoch: 2 }],
    [
      "a replacement source with the same clip key",
      { elements: [{ ...clip, src: "assets/b.mp4" }] },
    ],
    ["a replacement media kind", { elements: [{ ...clip, tag: "image" }] }],
  ])("does not apply a late duration to %s", (_label, change) => {
    act(() => usePlayerStore.setState(change));
    act(() => harness.complete?.());
    expect(usePlayerStore.getState().elements[0].sourceDuration).toBeUndefined();
  });

  it("keeps a valid source result when the same clip merely moves", () => {
    act(() => usePlayerStore.setState({ elements: [{ ...clip, start: 2 }] }));
    act(() => harness.complete?.());
    expect(usePlayerStore.getState().elements[0]).toMatchObject({ start: 2, sourceDuration: 11 });
  });

  it("replaces rediscovered stale metadata with the current source probe", () => {
    act(() => usePlayerStore.setState({ elements: [{ ...clip, sourceDuration: 3 }] }));
    act(() => harness.complete?.());
    expect(usePlayerStore.getState().elements[0].sourceDuration).toBe(11);
  });

  it("does not write after the player unmounts", () => {
    act(() => root.render(null));
    act(() => harness.complete?.());
    expect(usePlayerStore.getState().elements[0].sourceDuration).toBeUndefined();
  });
});
