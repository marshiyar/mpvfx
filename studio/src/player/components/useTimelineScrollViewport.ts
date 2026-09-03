import { useCallback, useRef, useState, type RefObject } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { STUDIO_TIMELINE_ROW_VIRTUALIZATION_ENABLED } from "./timelineRowVirtualizationFlag";

export interface TimelineScrollViewportSnapshot {
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly isScrolling: boolean;
}

const EMPTY_VIEWPORT: TimelineScrollViewportSnapshot = Object.freeze({
  scrollLeft: 0,
  scrollTop: 0,
  clientWidth: 0,
  clientHeight: 0,
  isScrolling: false,
});

function readTimelineScrollViewport(
  element: Pick<
    HTMLElement,
    "scrollLeft" | "scrollTop" | "clientWidth" | "clientHeight"
  >,
  isScrolling: boolean,
): TimelineScrollViewportSnapshot {
  return {
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop,
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    isScrolling,
  };
}

/**
 * The timeline scroll container's viewport plumbing — extracted verbatim from
 * Timeline.tsx (600-line studio cap): the ResizeObserver-backed viewport width
 * and the callback ref that wires it to the scroll element.
 */
export function useTimelineScrollViewport(
  scrollRef: RefObject<HTMLDivElement | null>,
): {
  viewport: TimelineScrollViewportSnapshot;
  setScrollRef: (el: HTMLDivElement | null) => void;
  syncScrollViewport: (el: HTMLDivElement, isScrolling?: boolean) => void;
} {
  const [viewport, setViewport] = useState<TimelineScrollViewportSnapshot>(EMPTY_VIEWPORT);
  const roRef = useRef<ResizeObserver | null>(null);
  const viewportRafRef = useRef(0);
  const scrollSettledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollingRef = useRef(false);

  const syncScrollViewport = useCallback((el: HTMLDivElement, isScrolling = false) => {
    // Row virtualization is the only consumer of the per-frame scroll snapshot.
    // With the flag off, publishing it re-rendered every mounted clip on every
    // scroll frame and bought nothing, so the scroll path stops here and
    // `isScrolling` stays false. Resize-driven and programmatic syncs arrive
    // through the immediate path below and still publish.
    if (isScrolling && !STUDIO_TIMELINE_ROW_VIRTUALIZATION_ENABLED) return;
    scrollingRef.current = isScrolling;
    const publish = () => {
      viewportRafRef.current = 0;
      setViewport(readTimelineScrollViewport(el, scrollingRef.current));
    };
    if (isScrolling) {
      if (!viewportRafRef.current) viewportRafRef.current = requestAnimationFrame(publish);
    } else {
      if (viewportRafRef.current) cancelAnimationFrame(viewportRafRef.current);
      publish();
      return;
    }
    if (scrollSettledTimerRef.current) clearTimeout(scrollSettledTimerRef.current);
    scrollSettledTimerRef.current = setTimeout(() => {
      scrollSettledTimerRef.current = null;
      scrollingRef.current = false;
      if (viewportRafRef.current) cancelAnimationFrame(viewportRafRef.current);
      publish();
    }, 100);
  }, []);

  const setScrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (roRef.current) {
        roRef.current.disconnect();
        roRef.current = null;
      }
      scrollRef.current = el;
      if (!el) {
        if (scrollSettledTimerRef.current) clearTimeout(scrollSettledTimerRef.current);
        scrollSettledTimerRef.current = null;
        scrollingRef.current = false;
        return;
      }

      const syncResize = () => {
        syncScrollViewport(el, scrollingRef.current);
      };

      syncResize();
      roRef.current = new ResizeObserver(syncResize);
      roRef.current.observe(el);
    },
    [scrollRef, syncScrollViewport],
  );

  useMountEffect(() => () => {
    roRef.current?.disconnect();
    if (viewportRafRef.current) cancelAnimationFrame(viewportRafRef.current);
    if (scrollSettledTimerRef.current) clearTimeout(scrollSettledTimerRef.current);
  });

  return { viewport, setScrollRef, syncScrollViewport };
}
