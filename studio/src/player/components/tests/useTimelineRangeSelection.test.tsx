// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePlayerStore, type TimelineElement } from "../../store/playerStore";
import { createTimelineRowGeometry, getTimelineRowTop } from "../timelineLayout";
import { createTimelineClipIndex } from "../../lib/timelineClipIndex";
import { useTimelineRangeSelection } from "../useTimelineRangeSelection";
import { configureTimelineTestViewport } from "./timelineTestViewport";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const elements: TimelineElement[] = [
  { id: "first", tag: "div", start: 1, duration: 1, track: 0 },
  { id: "offscreen", tag: "div", start: 2, duration: 1, track: 50 },
  { id: "base", tag: "div", start: 8, duration: 1, track: 99 },
];
const tracks = Array.from({ length: 100 }, (_, index) => index);
const geometry = createTimelineRowGeometry(
  tracks,
  tracks.map(() => 48),
);
const clipIndex = createTimelineClipIndex(
  tracks.map((track) => [track, elements.filter((element) => element.track === track)]),
);
const FIRST_ROW_Y = getTimelineRowTop(0) + 4;
const OFFSCREEN_ROW_Y = getTimelineRowTop(50) + 40;

function pointer(
  currentTarget: HTMLElement,
  pointerId: number,
  clientX: number,
  clientY: number,
  init: Partial<React.PointerEvent> = {},
): React.PointerEvent {
  return {
    button: 0,
    clientX,
    clientY,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    pointerId,
    currentTarget,
    target: currentTarget,
    ...init,
  } as React.PointerEvent;
}

function renderHarness(sessionEpoch = 1) {
  usePlayerStore.setState({ timelineSessionEpoch: sessionEpoch });
  const host = document.createElement("div");
  const scroll = document.createElement("div");
  scroll.setPointerCapture = vi.fn();
  configureTimelineTestViewport(scroll, geometry.canvasHeight);
  host.append(scroll);
  document.body.append(host);
  const root = createRoot(host);
  let api: ReturnType<typeof useTimelineRangeSelection> | null = null;
  const ppsRef = { current: 100 };
  const dragScrollRaf = { current: 0 };
  const isDragging = { current: false };
  const elementsRef = { current: elements };
  const rowGeometryRef = { current: geometry };
  const seekFromX = vi.fn();

  function Probe({ epoch }: { epoch: number }) {
    api = useTimelineRangeSelection({
      scrollRef: { current: scroll },
      ppsRef,
      effectiveDuration: 60,
      pps: 100,
      seekFromX,
      autoScrollDuringDrag: vi.fn(),
      dragScrollRaf,
      isDragging,
      elementsRef,
      clipIndex,
      rowGeometryRef,
      contentOrigin: 0,
      sessionEpoch: epoch,
    });
    return null;
  }

  act(() => root.render(<Probe epoch={sessionEpoch} />));
  return {
    scroll,
    root,
    get api() {
      if (!api) throw new Error("selection harness did not render");
      return api;
    },
    rerender(epoch: number) {
      usePlayerStore.setState({ timelineSessionEpoch: epoch });
      act(() => root.render(<Probe epoch={epoch} />));
    },
    seekFromX,
  };
}

function dragMarquee(
  view: ReturnType<typeof renderHarness>,
  options: { secondPointer?: boolean; release?: boolean } = {},
): void {
  act(() => {
    view.api.handlePointerDown(pointer(view.scroll, 7, 0, FIRST_ROW_Y));
    if (options.secondPointer) {
      view.api.handlePointerDown(pointer(view.scroll, 8, 500, FIRST_ROW_Y));
    }
    view.api.handlePointerMove(pointer(view.scroll, 7, 400, OFFSCREEN_ROW_Y));
    if (options.release) {
      view.api.handlePointerUp(pointer(view.scroll, 7, 400, OFFSCREEN_ROW_Y));
    }
  });
}

function expectSelectedIds(...ids: string[]): void {
  expect(usePlayerStore.getState().selectedElementIds).toEqual(new Set(ids));
}

function unmountHarness(view: ReturnType<typeof renderHarness>): void {
  act(() => view.root.unmount());
}

afterEach(() => {
  usePlayerStore.getState().reset();
  document.body.innerHTML = "";
});

describe("useTimelineRangeSelection", () => {
  it("selects enclosed keyframe diamonds and restores them on Escape", () => {
    const view = renderHarness();
    const diamond = document.createElement("button");
    diamond.dataset.keyframeSelectionKey = "first|position|native|50";
    diamond.getBoundingClientRect = () => ({ left: 180, top: 98, width: 12, height: 12, right: 192, bottom: 110 } as DOMRect);
    view.scroll.append(diamond);
    usePlayerStore.setState({ selectedElementId: "first", selectedKeyframes: new Set(["prior"]) });
    act(() => {
      view.api.handlePointerDown(pointer(view.scroll, 7, 160, 95));
      view.api.handlePointerMove(pointer(view.scroll, 7, 165, 96));
      expect(usePlayerStore.getState().selectedElementId).toBe("first");
      view.api.handlePointerMove(pointer(view.scroll, 7, 210, 120));
    });
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set(["first|position|native|50"]));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set(["prior"]));
    act(() => {
      view.api.handlePointerDown(pointer(view.scroll, 7, 160, 95, { shiftKey: true }));
      view.api.handlePointerMove(pointer(view.scroll, 7, 210, 120, { shiftKey: true }));
      view.api.handlePointerUp(pointer(view.scroll, 7, 210, 120, { shiftKey: true }));
    });
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set(["prior", "first|position|native|50"]));
    unmountHarness(view);
  });

  it("marquee-selects model clips across unmounted virtual rows", () => {
    const view = renderHarness();
    dragMarquee(view);

    expect(document.querySelectorAll("[data-clip]")).toHaveLength(0);
    expectSelectedIds("first", "offscreen");
    unmountHarness(view);
  });

  it("ignores another pointer and restores the pre-drag selection on cancellation", () => {
    usePlayerStore.getState().setSelectedElementId("base");
    const view = renderHarness();
    dragMarquee(view);
    act(() => view.api.handlePointerUp(pointer(view.scroll, 8, 400, OFFSCREEN_ROW_Y)));
    expectSelectedIds("first", "offscreen");

    act(() => view.api.handlePointerCancel(pointer(view.scroll, 7, 400, OFFSCREEN_ROW_Y)));
    expect(usePlayerStore.getState().selectedElementId).toBe("base");
    expectSelectedIds("base");
    unmountHarness(view);
  });

  it("keeps the original pointer owner when a second pointer presses", () => {
    const view = renderHarness();
    dragMarquee(view, { secondPointer: true, release: true });

    expectSelectedIds("first", "offscreen");
    unmountHarness(view);
  });

  it("commits a ruler click at its pointerdown position without requiring pointer movement", () => {
    const view = renderHarness();

    act(() => {
      view.api.handlePointerDown(pointer(view.scroll, 7, 375, 5));
      view.api.handlePointerUp(pointer(view.scroll, 7, 375, 5));
    });

    expect(view.seekFromX).toHaveBeenNthCalledWith(1, 375);
    expect(view.seekFromX).toHaveBeenNthCalledWith(2, 375);
    unmountHarness(view);
  });

  it("cancels a live marquee when the project session changes", () => {
    usePlayerStore.getState().setSelectedElementId("base");
    const view = renderHarness(1);
    dragMarquee(view);
    usePlayerStore.getState().setSelectedElementId("base");
    view.rerender(2);

    expect(usePlayerStore.getState().selectedElementId).toBe("base");
    expectSelectedIds("base");
    unmountHarness(view);
  });
});
