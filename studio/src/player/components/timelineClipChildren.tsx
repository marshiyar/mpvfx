import { type ReactNode } from "react";
import type { TimelineElement } from "../store/playerStore";
import type { TimelineTimeRange } from "../lib/timelineClipIndex";
import type { TrackVisualStyle } from "./timelineIcons";
import type { TimelineClipRenderContext } from "./TimelineTypes";

export function resolveClipRenderContext(
  element: TimelineElement,
  visibleTimeRange: TimelineTimeRange,
  interactive: boolean,
): TimelineClipRenderContext {
  if (interactive) return { priority: "interaction", rich: true };
  const visible =
    element.start < visibleTimeRange.end &&
    element.start + element.duration > visibleTimeRange.start;
  return { priority: visible ? "visible" : "overscan", rich: false };
}

export function renderClipChildren(
  element: TimelineElement,
  clipStyle: TrackVisualStyle,
  renderClipContent:
    | ((
        element: TimelineElement,
        style: { clip: string; label: string },
        context: TimelineClipRenderContext,
      ) => ReactNode)
    | undefined,
  renderClipOverlay: ((element: TimelineElement) => ReactNode) | undefined,
  context: TimelineClipRenderContext = { priority: "visible", rich: false },
): ReactNode {
  return (
    <>
      {renderClipOverlay?.(element)}
      {renderClipContent && (
        // borderRadius: inherit — the clip itself is overflow-visible (keyframe
        // diamonds hang outside its bounds), so the thumbnail layer must clip
        // itself to the clip's rounded corners or sharp corners poke out.
        <div className="absolute inset-0 overflow-hidden" style={{ borderRadius: "inherit" }}>
          {renderClipContent(element, clipStyle, context)}
        </div>
      )}
    </>
  );
}
