import { useMemo } from "react";
import {
  buildTimelineLogicalRows,
  type BuildTimelineLogicalRowsInput,
} from "./timelineKeyboardNavigation";

type TimelineLogicalRowsInput = BuildTimelineLogicalRowsInput;

/** Shared by rendering and focus coordination; stable input refs preserve memo identity. */
export function useTimelineLogicalRows({
  tracks,
  displayTrackOrder,
  laneCounts,
  selectedElementId,
  selectedElementIds,
  expandedClipIds,
  collapsedGroupIds,
  expandedLaneOwnerIds,
  groups,
  trackGroupOf,
  gsapAnimations,
  nativeLaneProjections,
}: TimelineLogicalRowsInput) {
  return useMemo(
    () =>
      buildTimelineLogicalRows({
        tracks,
        displayTrackOrder,
        laneCounts,
        selectedElementId,
        selectedElementIds,
        expandedClipIds,
        collapsedGroupIds,
        expandedLaneOwnerIds,
        groups,
        trackGroupOf,
        gsapAnimations,
        nativeLaneProjections,
      }),
    [
      displayTrackOrder,
      expandedClipIds,
      collapsedGroupIds,
      expandedLaneOwnerIds,
      groups,
      trackGroupOf,
      gsapAnimations,
      nativeLaneProjections,
      laneCounts,
      selectedElementId,
      selectedElementIds,
      tracks,
    ],
  );
}
