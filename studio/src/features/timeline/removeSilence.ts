import type { TimelineElement } from "../../player/index";

import type { SilenceRange } from "../../../shared/media/silenceDetection";
export { detectSilences, DEFAULT_SILENCE_REMOVAL_OPTIONS } from "../../../shared/media/silenceDetection";
export type { SilenceRange, SilenceRemovalOptions } from "../../../shared/media/silenceDetection";

export interface SilenceRemovalSegment extends SilenceRange {
  remove: boolean;
}

export interface SilenceRemovalPlan {
  cutTimes: number[];
  removedRanges: SilenceRange[];
  segments: SilenceRemovalSegment[];
  removedSeconds: number;
}

const RANGE_EPSILON_SECONDS = 1e-6;

/** Map source-time silence intervals onto a clip and divide it into keep/remove pieces. */
export function planSilenceRemoval(
  element: Pick<
    TimelineElement,
    "start" | "duration" | "playbackStart" | "playbackRate"
  >,
  sourceSilences: readonly SilenceRange[],
): SilenceRemovalPlan {
  const clipStart = element.start;
  const clipDuration = Math.max(0, element.duration);
  const clipEnd = clipStart + clipDuration;
  const sourceStart = Math.max(0, element.playbackStart ?? 0);
  const playbackRate =
    element.playbackRate != null && Number.isFinite(element.playbackRate) && element.playbackRate > 0
      ? element.playbackRate
      : 1;
  const sourceEnd = sourceStart + clipDuration * playbackRate;
  const orderedSourceRanges = sourceSilences
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end))
    .map((range) => ({ start: Math.max(sourceStart, range.start), end: Math.min(sourceEnd, range.end) }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);

  const removedRanges: SilenceRange[] = [];
  for (const range of orderedSourceRanges) {
    const mapped = {
      start: clipStart + (range.start - sourceStart) / playbackRate,
      end: clipStart + (range.end - sourceStart) / playbackRate,
    };
    const previous = removedRanges.at(-1);
    if (previous && mapped.start <= previous.end + RANGE_EPSILON_SECONDS) {
      previous.end = Math.max(previous.end, mapped.end);
    } else {
      removedRanges.push(mapped);
    }
  }

  const segments: SilenceRemovalSegment[] = [];
  const cutTimes = new Set<number>();
  let cursor = clipStart;
  for (const range of removedRanges) {
    if (range.start > cursor + RANGE_EPSILON_SECONDS) {
      segments.push({ start: cursor, end: range.start, remove: false });
      if (range.start < clipEnd - RANGE_EPSILON_SECONDS) cutTimes.add(range.start);
    }
    segments.push({ ...range, remove: true });
    if (range.start > clipStart + RANGE_EPSILON_SECONDS) cutTimes.add(range.start);
    if (range.end < clipEnd - RANGE_EPSILON_SECONDS) cutTimes.add(range.end);
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < clipEnd - RANGE_EPSILON_SECONDS) {
    segments.push({ start: cursor, end: clipEnd, remove: false });
  }

  return {
    cutTimes: [...cutTimes].sort((left, right) => left - right),
    removedRanges,
    segments,
    removedSeconds: removedRanges.reduce((sum, range) => sum + range.end - range.start, 0),
  };
}