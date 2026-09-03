// @vitest-environment happy-dom

import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveTime, usePlayerStore } from "../store/playerStore";
import { PLAYHEAD_HEAD_W } from "./timelineLayout";
import { useTimelinePlayhead } from "./useTimelinePlayhead";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONTENT_ORIGIN = 48;

function Harness({
  currentTime,
  pps = 100,
  zoomMode = "fit",
}: {
  currentTime: number;
  pps?: number;
  zoomMode?: "fit" | "manual";
}) {
  const playheadRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ppsRef = useRef(pps);
  const durationRef = useRef(30);
  const isDragging = useRef(false);
  const zoomModeRef = useRef<"fit" | "manual">(zoomMode);
  const manualZoomPercentRef = useRef(100);
  const fitPpsRef = useRef(pps);
  ppsRef.current = pps;
  fitPpsRef.current = pps;
  zoomModeRef.current = zoomMode;

  useTimelinePlayhead({
    playheadRef,
    scrollRef,
    ppsRef,
    durationRef,
    isDragging,
    currentTime,
    zoomMode,
    manualZoomPercent: 100,
    zoomModeRef,
    manualZoomPercentRef,
    fitPps: pps,
    fitPpsRef,
    effectiveDuration: 30,
    pps,
    timelineReady: true,
    elementsLength: 1,
    setZoomMode: vi.fn(),
    setManualZoomPercent: vi.fn(),
    contentOrigin: CONTENT_ORIGIN,
  });

  return (
    <div ref={scrollRef} data-testid="scroll">
      <div ref={playheadRef} data-testid="playhead" />
    </div>
  );
}

function translateX(element: HTMLElement): number {
  const match = element.style.transform.match(/translate3d\(([-\d.]+)px/);
  return match ? Number(match[1]) : 0;
}

function visualLeft(element: HTMLElement): number {
  return Number.parseFloat(element.style.left || "0") + translateX(element);
}

function mount(currentTime: number, pps = 100, zoomMode: "fit" | "manual" = "fit") {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = (
    nextTime: number,
    nextPps = pps,
    nextZoomMode: "fit" | "manual" = zoomMode,
  ) => {
    act(() =>
      root.render(
        <Harness currentTime={nextTime} pps={nextPps} zoomMode={nextZoomMode} />,
      ),
    );
  };
  render(currentTime, pps, zoomMode);
  const playhead = host.querySelector<HTMLElement>('[data-testid="playhead"]');
  const scroll = host.querySelector<HTMLElement>('[data-testid="scroll"]');
  if (!playhead) throw new Error("Expected playhead");
  if (!scroll) throw new Error("Expected scroll viewport");
  return { root, playhead, scroll, render };
}

let mountedRoot: Root | null = null;

beforeEach(() => {
  usePlayerStore.getState().reset();
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  usePlayerStore.getState().reset();
  document.body.innerHTML = "";
});

describe("useTimelinePlayhead", () => {
  it("moves live playback on a compositor transform without rewriting layout left every frame", () => {
    usePlayerStore.setState({ isPlaying: true });
    const view = mount(1);
    mountedRoot = view.root;
    const layoutLeft = view.playhead.style.left;

    act(() => liveTime.notify(1.25));

    expect(view.playhead.style.left).toBe(layoutLeft);
    expect(view.playhead.style.transform).toBe("translate3d(25px, 0px, 0px)");
    expect(view.playhead.style.willChange).toBe("transform");
  });

  it("does not rewind to a stale React time while live playback owns the playhead", () => {
    usePlayerStore.setState({ isPlaying: true });
    const view = mount(1);
    mountedRoot = view.root;

    act(() => liveTime.notify(2));
    const livePosition = visualLeft(view.playhead);

    view.render(1.5);

    expect(visualLeft(view.playhead)).toBe(livePosition);
    expect(visualLeft(view.playhead) + PLAYHEAD_HEAD_W / 2).toBe(CONTENT_ORIGIN + 2 * 100);
  });

  it("reflows from the latest live time when timeline zoom changes during playback", () => {
    usePlayerStore.setState({ isPlaying: true });
    const view = mount(1);
    mountedRoot = view.root;

    act(() => liveTime.notify(2));
    view.render(1, 150);

    expect(visualLeft(view.playhead) + PLAYHEAD_HEAD_W / 2).toBe(CONTENT_ORIGIN + 2 * 150);
  });

  it("keeps the viewport-space playhead steady once follow-scroll engages", () => {
    usePlayerStore.setState({ isPlaying: true });
    const view = mount(0, 100, "manual");
    mountedRoot = view.root;
    Object.defineProperty(view.scroll, "clientWidth", { configurable: true, value: 400 });
    Object.defineProperty(view.scroll, "scrollWidth", { configurable: true, value: 1400 });

    const viewportPositions = [2.641, 2.643, 2.646].map((time) => {
      act(() => liveTime.notify(time));
      return visualLeft(view.playhead) + PLAYHEAD_HEAD_W / 2 - view.scroll.scrollLeft;
    });

    viewportPositions.forEach((position) => expect(position).toBeCloseTo(312, 6));
  });
});
