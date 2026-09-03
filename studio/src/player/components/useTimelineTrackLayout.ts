import { useMemo, useRef } from "react";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import { animationLaneGroups } from "./TimelinePropertyLanes";
import { isAudioTimelineElement } from "../../utils/timelineInspector";
import { elementAutomationLanes, groupAutomationLanes } from "./automationLaneData";
import { usePlayerStore, type TimelineElement } from "../store/playerStore";
import type { DraggedClipState } from "./timelineClipDragTypes";
import { useTimelineTrackDerivations } from "./useTimelineTrackDerivations";
import {
  TRACK_H,
  createTimelineRowGeometry,
  type TimelineRowGeometry,
  trackHeights,
  type TimelineTrackHeightClip,
} from "./timelineLayout";
import type { TimelineTrackGroupInfo } from "./useTimelineTrackDerivations";
import type { NativeTimelineElementLaneProjection } from "./nativeTimelinePropertyLaneBridge";
import { groupAutomationElement } from "./groupAutomationElement";
import { AUTOMATION_LANE_H } from "./automationLaneHeight";
import type { NativeClipEffect } from "../../project/nativeProjectDocument";
import { timelineAttachedEffectLaneCount } from "./timelineAttachedEffects";

/** Automation rows the GROUP itself owns — its `data-automation`, not its members'. */
function groupOwnLaneCount(group: TimelineTrackGroupInfo): number {
  return groupAutomationLanes([groupAutomationElement(group, 0)]).length;
}

export { getTrackStyle } from "./timelineIcons";

/**
 * Whether this track draws the beat-dot strip: only where there are beats to
 * draw, and only on the track the user is working in — the selected clip's, or
 * the music track's when nothing is selected.
 */
export function trackShowsBeatStrip(
  els: readonly TimelineElement[],
  beatTimes: readonly number[] | undefined,
  ctx: {
    selectedElementId: string | null;
    isMusicTrack(element: TimelineElement): boolean;
  },
): boolean {
  if ((beatTimes?.length ?? 0) < 2) return false;
  return ctx.selectedElementId
    ? els.some((e) => (e.key ?? e.id) === ctx.selectedElementId)
    : els.some((e) => ctx.isMusicTrack(e));
}

/**
 * Automation lanes on one clip, or 0 for anything that is not audio.
 *
 * An audio clip can be worth expanding without carrying a single tween, so this
 * counts toward whether a track has anything to disclose. A function rather than
 * a map so every caller reads the same cached parse and none can drift.
 */
function automationLaneCountOf(element: TimelineElement): number {
  return isAudioTimelineElement(element) ? elementAutomationLanes(element).length : 0;
}

/**
 * Automation rows a TRACK reserves: the union over the clips sharing it, since
 * clips on one row share a lane row per property. Counting only the active clip's
 * lanes reserved a height that changed with the selection.
 */
function trackAutomationLaneCount(elements: readonly TimelineElement[]): number {
  return groupAutomationLanes(elements).length;
}

/**
 * Is this row disclosed? Expansion is stored per clip, but it reads as a property
 * of the ROW: the active clip changes with the selection, so asking only about it
 * collapsed the row the moment you clicked a sibling. Any expanded clip on the
 * track holds the row open — and the caret expands and collapses all of them
 * together (see TimelineLanes), so the two can only disagree on state predating
 * this rule or written by the keyframe auto-expand.
 */
export function isTrackRowExpanded(
  elements: readonly TimelineElement[],
  expandedClipIds: ReadonlySet<string>,
): boolean {
  return elements.some((element) => expandedClipIds.has(element.key ?? element.id));
}

/**
 * The single keyframed element whose property lanes a track shows when expanded.
 * A track can hold several elements (same z-index is common), but keyframes are
 * per-element, so we scope to ONE active element — the selected one if it's on
 * this track, otherwise the element with the most lanes. Selecting a clip is how
 * you switch which element you're keyframing. Returns null when no element on the
 * track has keyframes.
 */
export function resolveTrackKeyframeClip(
  elements: readonly TimelineElement[],
  laneCounts: ReadonlyMap<string, number>,
  selectedElementId: string | null,
  selectedElementIds: ReadonlySet<string>,
  automationLaneCount: (element: TimelineElement) => number = automationLaneCountOf,
): TimelineElement | null {
  // Automation counts toward "has something to disclose". Without it an audio
  // clip carrying envelopes but no tweens resolved to null, so its track got no
  // caret, no reserved height and no lanes — the automation was unreachable for
  // exactly the tracks the feature is for.
  const disclosable = (element: TimelineElement): number =>
    (laneCounts.get(element.key ?? element.id) ?? 0) + automationLaneCount(element);
  const keyframed = elements.filter((element) => disclosable(element) >= 1);
  if (keyframed.length === 0) return null;
  const selected = keyframed.find((element) => {
    const key = element.key ?? element.id;
    return key === selectedElementId || selectedElementIds.has(key);
  });
  if (selected) return selected;
  // Most lanes wins, first one on a tie (same as the old stable sort), but as a
  // reduce over the already non-empty list so there's no index to assert on.
  return keyframed.reduce((best, element) =>
    disclosable(element) > disclosable(best) ? element : best,
  );
}

/**
 * Resolve the number of visible property-group rows per clip while native
 * migration is incremental. Native owns only the groups it projects; legacy
 * GSAP groups not represented by that projection still need row height and
 * disclosure state. The union also prevents a migrated group from being
 * counted twice.
 */
export function mergeTimelineLaneCounts(
  gsapAnimations: ReadonlyMap<string, readonly GsapAnimation[]>,
  nativeLaneProjections: ReadonlyMap<string, NativeTimelineElementLaneProjection>,
): ReadonlyMap<string, number> {
  const clipIds = new Set([...gsapAnimations.keys(), ...nativeLaneProjections.keys()]);
  return new Map(
    [...clipIds].map((clipId) => {
      const groups = new Set<string>();
      for (const animation of gsapAnimations.get(clipId) ?? []) {
        for (const group of animationLaneGroups(animation)) groups.add(group);
      }
      for (const lane of nativeLaneProjections.get(clipId)?.lanes ?? []) {
        groups.add(lane.propertyGroup);
      }
      return [clipId, groups.size] as const;
    }),
  );
}

/** Lanes per clip: the count of distinct property groups whose tween contributes
 *  a lane (real keyframes or a synthesizable flat tween). */
function computeLaneCounts(
  tracks: [number, TimelineElement[]][],
  gsapAnimations: Map<string, GsapAnimation[]>,
  nativeLaneCounts: ReadonlyMap<string, number>,
): Map<string, number> {
  const laneCounts = new Map<string, number>();
  for (const [, elements] of tracks) {
    for (const element of elements) {
      const clipId = element.key ?? element.id;
      const nativeCount = nativeLaneCounts.get(clipId);
      if (nativeCount !== undefined) {
        laneCounts.set(clipId, nativeCount);
        continue;
      }
      const propertyGroups = new Set<string>();
      for (const animation of gsapAnimations.get(clipId) ?? []) {
        // Same helper the rendered lanes count through, so a reserved row and a
        // drawn lane can never disagree.
        for (const group of animationLaneGroups(animation)) propertyGroups.add(group);
      }
      laneCounts.set(clipId, propertyGroups.size);
    }
  }
  return laneCounts;
}

/** Group anchor rows have no elements of their own (`groupTimelineTracks`
 *  pushes them as `[anchorKey, []]`), so `trackHeights` — which only ever
 *  looks at a row's clips — always gives them TRACK_H. Override those
 *  specific rows post-hoc: TRACK_H while collapsed, plus the group's own
 *  automation rows once its `∿` is open. */
function applyGroupStripHeights(
  tracks: readonly (readonly [number, readonly TimelineElement[]])[],
  rowHeights: number[],
  groups: readonly TimelineTrackGroupInfo[],
  expandedLaneOwnerIds: ReadonlySet<string>,
): number[] {
  if (groups.length === 0) return rowHeights;
  const groupByAnchor = new Map(groups.map((group) => [group.anchorKey, group]));
  return tracks.map(([track], index) => {
    const group = groupByAnchor.get(track);
    if (!group || !expandedLaneOwnerIds.has(group.id)) return rowHeights[index] ?? TRACK_H;
    // The group's own automation rows, which its `∿` discloses. A row sized
    // without them clipped every lane it had just promised in the count.
    return TRACK_H + groupOwnLaneCount(group) * AUTOMATION_LANE_H;
  });
}

function useTimelineRowHeights(
  tracks: [number, TimelineElement[]][],
  gsapAnimations: Map<string, GsapAnimation[]>,
  selectedElementId: string | null,
  selectedElementIds: ReadonlySet<string>,
  groups: readonly TimelineTrackGroupInfo[],
  nativeLaneCounts: ReadonlyMap<string, number>,
  nativeEffectMap: ReadonlyMap<string, readonly NativeClipEffect[]>,
) {
  const expandedClipIds = usePlayerStore((s) => s.expandedClipIds);
  const expandedLaneOwnerIds = usePlayerStore((s) => s.expandedLaneOwnerIds);
  const { laneCounts, rowGeometry } = useMemo(() => {
    const laneCounts = computeLaneCounts(tracks, gsapAnimations, nativeLaneCounts);
    // Keyframe lanes follow only the active clip, so a track with several
    // keyframed elements never reserves empty lanes for the ones not shown.
    // Automation lanes follow the whole row: they are shared per property.
    const heightTracks: TimelineTrackHeightClip[][] = tracks.map(([, elements]) => {
      const active = resolveTrackKeyframeClip(
        elements,
        laneCounts,
        selectedElementId,
        selectedElementIds,
      );
      const effectLaneCount = timelineAttachedEffectLaneCount(elements, nativeEffectMap);
      if (!active && effectLaneCount === 0) return [];
      const holdingOpen = elements.find((element) =>
        expandedClipIds.has(element.key ?? element.id),
      );
      const clipId = holdingOpen
        ? (holdingOpen.key ?? holdingOpen.id)
        : active
          ? (active.key ?? active.id)
          : (elements[0]?.key ?? elements[0]?.id ?? "");
      return [
        {
          clipId,
          laneCount: active ? (laneCounts.get(active.key ?? active.id) ?? 0) : 0,
          automationLaneCount: active ? trackAutomationLaneCount(elements) : 0,
          effectLaneCount,
        },
      ];
    });
    const rowHeights = applyGroupStripHeights(
      tracks,
      trackHeights(heightTracks, expandedClipIds),
      groups,
      expandedLaneOwnerIds,
    );
    return {
      laneCounts,
      rowGeometry: createTimelineRowGeometry(
        tracks.map(([track]) => track),
        rowHeights,
      ),
    };
  }, [
    expandedLaneOwnerIds,
    expandedClipIds,
    gsapAnimations,
    groups,
    tracks,
    selectedElementId,
    selectedElementIds,
    nativeLaneCounts,
    nativeEffectMap,
  ]);
  const rowGeometryRef = useRef<TimelineRowGeometry>(rowGeometry);
  rowGeometryRef.current = rowGeometry;
  return {
    laneCounts,
    rowGeometry,
    rowGeometryRef,
    rowHeights: rowGeometry.rowHeights,
  };
}

const EMPTY_NATIVE_LANE_COUNTS: ReadonlyMap<string, number> = new Map();
const EMPTY_NATIVE_EFFECT_MAP: ReadonlyMap<string, readonly NativeClipEffect[]> = new Map();
export const MIN_TIMELINE_TRACK_STRIPS = 6;

/**
 * Keep the occupied timeline's vertical structure stable without inventing
 * clips or project data. Empty projects still use TimelineEmptyState; once a
 * first clip exists, these integer keys are real drop targets that disappear
 * one-for-one as occupied rows take their place.
 */
export function padTimelineTrackOrder(
  trackOrder: readonly number[],
  occupiedTrackKeys: readonly number[],
): number[] {
  if (trackOrder.length === 0 || trackOrder.length >= MIN_TIMELINE_TRACK_STRIPS) {
    return [...trackOrder];
  }
  const usedIntegerKeys = new Set(occupiedTrackKeys.filter(Number.isInteger));
  let nextTrack = usedIntegerKeys.size > 0 ? Math.max(...usedIntegerKeys) + 1 : 0;
  const padded = [...trackOrder];
  while (padded.length < MIN_TIMELINE_TRACK_STRIPS) {
    while (usedIntegerKeys.has(nextTrack)) nextTrack += 1;
    padded.push(nextTrack);
    usedIntegerKeys.add(nextTrack);
    nextTrack += 1;
  }
  return padded;
}

export function useTimelineTrackLayout(
  expandedElements: TimelineElement[],
  gsapAnimations: Map<string, GsapAnimation[]>,
  selectedElementId: string | null,
  selectedElementIds: ReadonlySet<string>,
  nativeLaneCounts: ReadonlyMap<string, number> = EMPTY_NATIVE_LANE_COUNTS,
  nativeEffectMap: ReadonlyMap<string, readonly NativeClipEffect[]> = EMPTY_NATIVE_EFFECT_MAP,
) {
  const { tracks, trackStyles, trackOrder, groups, trackGroupOf } =
    useTimelineTrackDerivations(expandedElements);
  const trackOrderRef = useRef(trackOrder);
  trackOrderRef.current = trackOrder;
  const { laneCounts, rowGeometry, rowGeometryRef, rowHeights } = useTimelineRowHeights(
    tracks,
    gsapAnimations,
    selectedElementId,
    selectedElementIds,
    groups,
    nativeLaneCounts,
    nativeEffectMap,
  );

  return {
    tracks,
    trackStyles,
    trackOrder,
    trackOrderRef,
    laneCounts,
    rowGeometry,
    rowGeometryRef,
    rowHeights,
    groups,
    trackGroupOf,
  };
}

function useDisplayRowHeights(
  displayTrackOrder: readonly number[],
  rowGeometry: TimelineRowGeometry,
) {
  return useMemo(
    () =>
      displayTrackOrder.map((track) => {
        const row = rowGeometry.getRowIndex(track);
        return row < 0 ? TRACK_H : rowGeometry.getRowHeight(row);
      }),
    [displayTrackOrder, rowGeometry],
  );
}

function useDisplayTrackOrder(draggedClip: DraggedClipState | null, trackOrder: number[]) {
  return useMemo(() => {
    if (!draggedClip?.started || trackOrder.includes(draggedClip.previewTrack)) return trackOrder;
    // A group's members sit out of raw numeric order (pulled under their
    // anchor row), so a plain numeric sort here would undo that grouping the
    // moment a clip drags onto a brand-new track. Insert the new preview
    // track only relative to other REAL (integer) tracks, leaving any
    // fractional group-anchor keys exactly where grouping placed them.
    const preview = draggedClip.previewTrack;
    const result: number[] = [];
    let inserted = false;
    for (const key of trackOrder) {
      if (!inserted && Number.isInteger(key) && key > preview) {
        result.push(preview);
        inserted = true;
      }
      result.push(key);
    }
    if (!inserted) result.push(preview);
    return result;
  }, [draggedClip, trackOrder]);
}

export function useTimelineDisplayLayout(
  draggedClip: DraggedClipState | null,
  trackOrder: number[],
  rowGeometry: TimelineRowGeometry,
) {
  const displayTrackOrder = useDisplayTrackOrder(draggedClip, trackOrder);
  const displayRowHeights = useDisplayRowHeights(displayTrackOrder, rowGeometry);
  const displayRowGeometry = useMemo(
    () => createTimelineRowGeometry(displayTrackOrder, displayRowHeights),
    [displayTrackOrder, displayRowHeights],
  );
  return {
    displayTrackOrder,
    displayRowHeights: displayRowGeometry.rowHeights,
    rowGeometry: displayRowGeometry,
    totalH: displayRowGeometry.canvasHeight,
  };
}
