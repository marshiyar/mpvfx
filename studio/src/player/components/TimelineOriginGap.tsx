import { TRACK_H } from "./timelineLayout";

interface TimelineOriginGapProps {
  width: number;
  backgroundColor: string;
  height?: number;
}

/**
 * Visible spacer between the sticky track header and the t=0 content origin.
 * It replaces an equal-width flex margin, so clips, ruler ticks, and the
 * playhead keep their existing alignment while the reserved space is legible.
 */
export function TimelineOriginGap({ width, backgroundColor, height = TRACK_H }: TimelineOriginGapProps) {
  if (width <= 0) return null;
  return (
    <div
      aria-hidden="true"
      data-timeline-origin-gap="true"
      className="pointer-events-none shrink-0"
      style={{ width, height, backgroundColor }}
    />
  );
}
