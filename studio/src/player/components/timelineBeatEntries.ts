import type { TimelineTimeRange } from "../lib/timelineClipIndex";

export interface TimelineBeatEntry {
  readonly index: number;
  readonly time: number;
  readonly strength: number | undefined;
}

function findFirstTimeAtOrAfter(times: readonly number[], target: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((times[mid] ?? Number.POSITIVE_INFINITY) < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function getTimelineBeatEntries(
  beatTimes: readonly number[] | undefined,
  beatStrengths: readonly number[] | undefined,
  range: TimelineTimeRange | undefined,
  pinnedIndexes: ReadonlySet<number> = new Set(),
): readonly TimelineBeatEntry[] {
  if (!beatTimes?.length) return [];
  const start = range?.start ?? Number.NEGATIVE_INFINITY;
  const end = range?.end ?? Number.POSITIVE_INFINITY;
  const selected = new Set<number>();
  for (let index = findFirstTimeAtOrAfter(beatTimes, start); index < beatTimes.length; index++) {
    const time = beatTimes[index];
    if (time === undefined || time >= end) break;
    selected.add(index);
  }
  for (const index of pinnedIndexes) {
    if (index >= 0 && index < beatTimes.length) selected.add(index);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => ({ index, time: beatTimes[index]!, strength: beatStrengths?.[index] }));
}
