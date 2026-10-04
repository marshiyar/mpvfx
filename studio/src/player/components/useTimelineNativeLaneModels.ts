import { useMemo } from "react";
import type { NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import type { TimelineElement } from "../store/playerStore";
import { buildNativeTimelineLaneProjectionMap } from "./nativeTimelinePropertyLaneBridge";
import { buildNativeTimelineEffectMap } from "./timelineAttachedEffects";
import { mergeTimelineLaneCounts } from "./useTimelineTrackLayout";

/** Keep native property lanes, clip effects, and rendered row counts in sync. */
export function useTimelineNativeLaneModels(
  nativeProjectDocument: NativeProjectDocument | null,
  expandedElements: readonly TimelineElement[],
  gsapAnimations: Parameters<typeof mergeTimelineLaneCounts>[0],
) {
  const nativeLaneProjections = useMemo(
    () => buildNativeTimelineLaneProjectionMap(nativeProjectDocument, expandedElements),
    [expandedElements, nativeProjectDocument],
  );
  const nativeEffectMap = useMemo(
    () => buildNativeTimelineEffectMap(nativeProjectDocument, expandedElements),
    [expandedElements, nativeProjectDocument],
  );
  const timelineLaneCountMap = useMemo(
    () => mergeTimelineLaneCounts(gsapAnimations, nativeLaneProjections, expandedElements),
    [expandedElements, gsapAnimations, nativeLaneProjections],
  );
  return { nativeLaneProjections, nativeEffectMap, timelineLaneCountMap };
}
