import type { TimelineElement } from "../store/playerStore";
import { isAudioTimelineElement } from "../../features/timeline/timelineInspector";
import { INSERT_BOUNDARY_BAND } from "./timelineLayout";

function isSameMediaZone(element: TimelineElement, isAudio: boolean): boolean {
  return isAudioTimelineElement(element) === isAudio;
}

function resolveAutomaticInsertRow(
  order: readonly number[],
  desiredTrack: number,
  preferInsertAbove: boolean,
): number {
  const desiredIndex = order.indexOf(desiredTrack);
  if (desiredIndex < 0) return preferInsertAbove ? 0 : order.length;
  return Math.max(0, Math.min(order.length, desiredIndex + (preferInsertAbove ? 0 : 1)));
}

/**
 * Resolve a clip drop without putting overlapping clips in the same media
 * zone and row. Audio and visual clips intentionally have separate sub-rows,
 * so they may still share an authored track; two visual clips (or two audio
 * clips) may not occupy the same time span on that track.
 */
export function resolveZoneDropPlacement(input: {
  order: number[];
  audioTracks: ReadonlySet<number>;
  elements: TimelineElement[];
  desiredTrack: number;
  deliberateInsertRow: number | null;
  start: number;
  duration: number;
  dragKey: string;
  isAudio: boolean;
  preferInsertAbove?: boolean;
}): { track: number; insertRow: number | null } {
  // An explicit boundary drop is a topology edit. Honor it even when the new
  // clip overlaps the clips that will be shifted below the inserted row.
  if (input.deliberateInsertRow != null) {
    return { track: input.desiredTrack, insertRow: input.deliberateInsertRow };
  }

  const zoneElements = input.elements.filter((element) =>
    isSameMediaZone(element, input.isAudio),
  );
  // Every displayed track is a valid destination for either media zone. A
  // visual clip can join an audio-only row (and vice versa) to form a mixed
  // track; only same-zone clips participate in the collision test below.
  const zoneOrder = input.order;
  const placement = resolvePlacement({
    elements: zoneElements,
    desiredTrack: input.desiredTrack,
    start: input.start,
    duration: input.duration,
    trackOrder: zoneOrder,
    excludeKey: input.dragKey,
  });

  if (!placement.needsInsert) {
    return { track: placement.track, insertRow: null };
  }

  // Every same-zone row is occupied for this span. Create a new row on the
  // side of the pointer's aimed row instead of leaving the clips coincident.
  // The caller's insert commit performs the atomic renumbering.
  return {
    track: input.desiredTrack,
    insertRow: resolveAutomaticInsertRow(
      input.order,
      input.desiredTrack,
      input.preferInsertAbove ?? false,
    ),
  };

}

/**
 * Decide whether a vertical drag is inserting a new track at a lane boundary.
 * `rowFloat` is the pointer's position in track-height units from the top of the
 * first lane (0 = top of lane 0). Returns the boundary row to insert at
 * (0 = above the top lane, `trackCount` = below the bottom), or null when the
 * pointer is over a lane's middle band (a normal move/target). The default band
 * preserves collapsed-row behavior; production passes the concrete row's band.
 */
export function resolveInsertRow(
  rowFloat: number,
  trackCount: number,
  band: number = INSERT_BOUNDARY_BAND,
): number | null {
  if (trackCount === 0) return 0;
  if (rowFloat <= 0) return 0;
  if (rowFloat >= trackCount) return trackCount;
  const lane = Math.floor(rowFloat);
  const frac = rowFloat - lane;
  if (frac < band) return lane;
  if (frac > 1 - band) return lane + 1;
  return null;
}

/** Half-open overlap test: [aStart, aEnd) intersects [bStart, bEnd). */
export function timeRangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * True when no clip on `track` overlaps [start, end) — excluding the clip
 * identified by `excludeKey` (the one being dragged).
 */
export function isLaneFree(
  elements: TimelineElement[],
  track: number,
  start: number,
  end: number,
  excludeKey: string | null,
): boolean {
  return !elements.some(
    (el) =>
      (el.key ?? el.id) !== excludeKey &&
      el.track === track &&
      timeRangesOverlap(start, end, el.start, el.start + el.duration),
  );
}

export interface PlacementInput {
  elements: TimelineElement[];
  desiredTrack: number;
  start: number;
  duration: number;
  trackOrder: number[];
  excludeKey: string | null;
}

export interface PlacementResult {
  /** The lane the clip should land on. */
  track: number;
  /**
   * True when no existing lane was free and the caller should insert a new
   * track instead of landing on `track` (which is then the desired lane as a
   * last-resort fallback). Consumed in later stages (2b/2c); stage 2a ignores it.
   */
  needsInsert: boolean;
}

/**
 * Resolve a newly inserted media asset's track. Unlike an interactive clip
 * drag, asset insertion has no insert-row transaction available, so a fully
 * occupied destination gets a fresh track key instead of being written on top
 * of an existing same-zone clip.
 */
export function resolveCollisionFreeTrack(input: {
  elements: TimelineElement[];
  trackOrder: number[];
  desiredTrack: number;
  start: number;
  duration: number;
  isAudio: boolean;
}): number {
  const zoneElements = input.elements.filter((element) =>
    isSameMediaZone(element, input.isAudio),
  );
  const placement = resolvePlacement({
    elements: zoneElements,
    desiredTrack: input.desiredTrack,
    start: input.start,
    duration: input.duration,
    trackOrder: input.trackOrder,
    excludeKey: null,
  });
  if (!placement.needsInsert) return placement.track;

  const highestTrack = input.trackOrder.reduce(
    (highest, track) => (Number.isFinite(track) ? Math.max(highest, track) : highest),
    -1,
  );
  return Math.ceil(highestTrack + 1);
}

/**
 * Resolve where a dragged clip should land, avoiding overlap. If the desired
 * lane is free, keep it. Otherwise search the nearest free lane, **preferring
 * up** (all lanes above, nearest first), then down. If none is free, signal an
 * insert and fall back to the desired lane.
 */
export function resolvePlacement({
  elements,
  desiredTrack,
  start,
  duration,
  trackOrder,
  excludeKey,
}: PlacementInput): PlacementResult {
  const end = start + duration;
  const idx = trackOrder.indexOf(desiredTrack);
  // desiredTrack is not one of the zone's lanes — the clip's kind-zone has no lane
  // yet (e.g. an audio clip dropped on a visual-only timeline). This MUST be checked
  // BEFORE the isLaneFree short-circuit below: a free-aimed span on a foreign-zone
  // lane (an audio clip aimed at an empty stretch of a visual-only timeline) is
  // "free" only because that lane belongs to the wrong zone. Landing there would
  // put the clip in the wrong kind-zone, so signal an insert to create the zone's
  // first lane instead — regardless of whether the aimed span is occupied (#2195).
  if (idx === -1) return { track: desiredTrack, needsInsert: true };

  if (isLaneFree(elements, desiredTrack, start, end, excludeKey)) {
    return { track: desiredTrack, needsInsert: false };
  }

  // Prefer up: nearest lane above first, then the rest above.
  for (let up = idx - 1; up >= 0; up--) {
    if (isLaneFree(elements, trackOrder[up], start, end, excludeKey)) {
      return { track: trackOrder[up], needsInsert: false };
    }
  }
  // Then down: nearest lane below first.
  for (let down = idx + 1; down < trackOrder.length; down++) {
    if (isLaneFree(elements, trackOrder[down], start, end, excludeKey)) {
      return { track: trackOrder[down], needsInsert: false };
    }
  }
  return { track: desiredTrack, needsInsert: true };
}
