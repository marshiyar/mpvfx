import { useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { liveTime, usePlayerStore, type ZoomMode } from "../store/playerStore";
import { useMountEffect } from "../../hooks/useMountEffect";
import { getPinchTimelineZoomPercent } from "./timelineZoom";
import {
  getTimelinePlaybackFollowScrollLeft,
  getTimelinePlayheadLeft,
  getTimelineScrubTime,
  getTimelineScrollLeftForZoomTransition,
  getTimelineScrollLeftForZoomAnchor,
  shouldAutoScrollTimeline,
} from "./timelineLayout";
import { applyTimelineHorizontalAutoScrollStep } from "./timelineEditing";

interface UseTimelinePlayheadInput {
  playheadRef: React.RefObject<HTMLDivElement | null>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  ppsRef: React.RefObject<number>;
  durationRef: React.RefObject<number>;
  isDragging: React.RefObject<boolean>;
  currentTime: number;
  zoomMode: ZoomMode;
  manualZoomPercent: number;
  zoomModeRef: React.RefObject<ZoomMode>;
  manualZoomPercentRef: React.RefObject<number>;
  fitPps: number;
  fitPpsRef: React.RefObject<number>;
  effectiveDuration: number;
  pps: number;
  timelineReady: boolean;
  elementsLength: number;
  setZoomMode: (mode: ZoomMode) => void;
  setManualZoomPercent: (percent: number) => void;
  onSeek?: (time: number) => void;
  contentOrigin: number;
}

export function useTimelinePlayhead({
  playheadRef,
  scrollRef,
  ppsRef,
  durationRef,
  isDragging,
  currentTime,
  zoomMode,
  zoomModeRef,
  manualZoomPercentRef,
  fitPps: _fitPps,
  fitPpsRef,
  effectiveDuration,
  pps,
  timelineReady,
  elementsLength,
  setZoomMode,
  setManualZoomPercent,
  onSeek,
  contentOrigin,
}: UseTimelinePlayheadInput) {
  const dragScrollRaf = useRef(0);
  const previousZoomModeRef = useRef<ZoomMode | null>(zoomMode);
  // Center-anchored magnify: keep the time at the viewport center fixed when
  // the zoom level (pps) changes via the toolbar / slider. The pinch handler
  // anchors at the cursor instead, so it opts out via `skipCenterAnchorRef`.
  const previousAnchorPpsRef = useRef(pps);
  const skipCenterAnchorRef = useRef(false);
  const contentOriginRef = useRef(contentOrigin);
  const latestVisualTimeRef = useRef(currentTime);
  const playheadLayoutLeftRef = useRef<number | null>(null);
  contentOriginRef.current = contentOrigin;

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const prevPps = previousAnchorPpsRef.current;
    previousAnchorPpsRef.current = pps;
    // Always consume the skip flag, even when pps didn't change — otherwise a
    // pinch that produced no pps change (already at the zoom clamp) would strand
    // it true and the next toolbar zoom would wrongly skip center-anchoring.
    const skip = skipCenterAnchorRef.current;
    skipCenterAnchorRef.current = false;
    if (!scroll || pps === prevPps || skip) return;
    const nextScrollLeft = getTimelineScrollLeftForZoomAnchor({
      pointerX: scroll.clientWidth / 2,
      currentScrollLeft: scroll.scrollLeft,
      contentOrigin,
      currentPixelsPerSecond: prevPps,
      nextPixelsPerSecond: pps,
      duration: durationRef.current,
    });
    const maxScrollLeft = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
    scroll.scrollLeft = Math.max(0, Math.min(maxScrollLeft, nextScrollLeft));
  }, [pps, scrollRef, durationRef, contentOrigin]);

  const commitPlayheadLayoutPosition = useCallback(
    (time: number) => {
      if (!playheadRef.current || durationRef.current <= 0) return;
      const safeTime = Number.isFinite(time) ? Math.max(0, time) : latestVisualTimeRef.current;
      const left = getTimelinePlayheadLeft(
        safeTime,
        ppsRef.current,
        contentOriginRef.current,
      );
      latestVisualTimeRef.current = safeTime;
      playheadLayoutLeftRef.current = left;
      playheadRef.current.style.left = `${left}px`;
      playheadRef.current.style.transform = "translate3d(0px, 0px, 0px)";
      playheadRef.current.style.willChange = "transform";
    },
    [playheadRef, durationRef, ppsRef],
  );

  useEffect(() => {
    // liveTime is the frame-rate owner while playback runs. React's currentTime
    // intentionally updates less often, so using it here would briefly rewind
    // the playhead whenever unrelated renders or zoom changes occur.
    const time = usePlayerStore.getState().isPlaying ? latestVisualTimeRef.current : currentTime;
    commitPlayheadLayoutPosition(time);
  }, [currentTime, pps, contentOrigin, commitPlayheadLayoutPosition]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || zoomMode !== "fit") return;
    scroll.scrollLeft = 0;
  }, [zoomMode, pps, scrollRef]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) {
      previousZoomModeRef.current = zoomMode;
      return;
    }
    scroll.scrollLeft = getTimelineScrollLeftForZoomTransition(
      previousZoomModeRef.current,
      zoomMode,
      scroll.scrollLeft,
    );
    previousZoomModeRef.current = zoomMode;
  }, [zoomMode, scrollRef]);

  useMountEffect(() => {
    const unsub = liveTime.subscribe((t) => {
      if (!playheadRef.current || durationRef.current <= 0) return;
      const time = Number.isFinite(t) ? Math.max(0, t) : latestVisualTimeRef.current;
      latestVisualTimeRef.current = time;
      const playheadLeft = getTimelinePlayheadLeft(
        time,
        ppsRef.current,
        contentOriginRef.current,
      );
      if (playheadLayoutLeftRef.current === null) {
        playheadLayoutLeftRef.current = playheadLeft;
        playheadRef.current.style.left = `${playheadLeft}px`;
      }
      const translateX = playheadLeft - playheadLayoutLeftRef.current;
      playheadRef.current.style.transform = `translate3d(${translateX}px, 0px, 0px)`;
      playheadRef.current.style.willChange = "transform";
      const playheadX = contentOriginRef.current + time * ppsRef.current;
      const scroll = scrollRef.current;
      if (
        !scroll ||
        !usePlayerStore.getState().isPlaying ||
        isDragging.current ||
        zoomModeRef.current === "fit"
      ) {
        return;
      }
      const nextScrollLeft = getTimelinePlaybackFollowScrollLeft({
        playheadX,
        currentScrollLeft: scroll.scrollLeft,
        viewportWidth: scroll.clientWidth,
        contentOrigin: contentOriginRef.current,
        maxScrollLeft: scroll.scrollWidth - scroll.clientWidth,
      });
      if (nextScrollLeft !== scroll.scrollLeft) {
        scroll.scrollLeft = nextScrollLeft;
      }
    });
    return unsub;
  });

  const seekFromX = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el || effectiveDuration <= 0) return;
      const rect = el.getBoundingClientRect();
      const time = getTimelineScrubTime({
        clientX,
        viewportLeft: rect.left,
        scrollLeft: el.scrollLeft,
        contentOrigin,
        pixelsPerSecond: pps,
        duration: effectiveDuration,
      });
      liveTime.notify(time);
      onSeek?.(time);
    },
    [scrollRef, effectiveDuration, pps, onSeek, contentOrigin],
  );

  const autoScrollDuringDrag = useCallback(
    (clientX: number) => {
      cancelAnimationFrame(dragScrollRaf.current);
      const el = scrollRef.current;
      if (
        !el ||
        !isDragging.current ||
        !shouldAutoScrollTimeline(zoomModeRef.current, el.scrollWidth, el.clientWidth)
      )
        return;
      if (applyTimelineHorizontalAutoScrollStep(el, clientX)) {
        seekFromX(clientX);
        dragScrollRaf.current = requestAnimationFrame(() => autoScrollDuringDrag(clientX));
      }
    },
    [scrollRef, isDragging, zoomModeRef, seekFromX],
  );

  const handlePinchWheel = useCallback(
    (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      const scroll = scrollRef.current;
      if (!scroll || durationRef.current <= 0 || fitPpsRef.current <= 0 || ppsRef.current <= 0)
        return;
      e.preventDefault();
      e.stopPropagation();
      const rect = scroll.getBoundingClientRect();
      const nextZoomPercent = getPinchTimelineZoomPercent(
        e.deltaY,
        zoomModeRef.current,
        manualZoomPercentRef.current,
        fitPpsRef.current,
      );
      if (nextZoomPercent === manualZoomPercentRef.current && zoomModeRef.current === "manual")
        return;
      const nextPps = fitPpsRef.current * (nextZoomPercent / 100);
      const nextScrollLeft = getTimelineScrollLeftForZoomAnchor({
        pointerX: e.clientX - rect.left,
        currentScrollLeft: scroll.scrollLeft,
        contentOrigin,
        currentPixelsPerSecond: ppsRef.current,
        nextPixelsPerSecond: nextPps,
        duration: durationRef.current,
      });
      // Pinch anchors at the cursor (below), so skip the center-anchor effect.
      skipCenterAnchorRef.current = true;
      setZoomMode("manual");
      setManualZoomPercent(nextZoomPercent);
      requestAnimationFrame(() => {
        const maxScrollLeft = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
        scroll.scrollLeft = Math.min(maxScrollLeft, nextScrollLeft);
      });
    },
    [
      scrollRef,
      durationRef,
      fitPpsRef,
      ppsRef,
      zoomModeRef,
      manualZoomPercentRef,
      setManualZoomPercent,
      setZoomMode,
      contentOrigin,
    ],
  );

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.addEventListener("wheel", handlePinchWheel, { passive: false, capture: true });
    return () => {
      scroll.removeEventListener("wheel", handlePinchWheel, { capture: true });
    };
  }, [handlePinchWheel, scrollRef, timelineReady, elementsLength]);

  return { seekFromX, autoScrollDuringDrag, dragScrollRaf };
}
