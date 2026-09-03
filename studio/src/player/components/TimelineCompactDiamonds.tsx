import type { TimelineElement } from "../store/playerStore";
import { classifyPropertyGroup } from "@hyperframes/core/gsap-parser";
import { CLIP_Y } from "./timelineLayout";
import type { TimelineLaneBaseProps } from "./timelineLaneProps";
import { TimelineClipDiamonds } from "./TimelineClipDiamonds";
import {
  getTimelineNativePropertyLanes,
  type NativeTimelinePropertyLane,
} from "./TimelinePropertyLanes";
import type { TimelineDiamondKeyframe } from "./timelineDiamondTypes";

const NON_ANIMATED_LEGACY_PROPERTIES = new Set(["transformOrigin", "_auto", "data"]);

/** Data accepted by the compact renderer from either legacy cache or native lanes. */
type TimelineCompactKeyframesData = {
  format: string;
  keyframes: TimelineDiamondKeyframe[];
  ease?: string;
  easeEach?: string;
};

interface TimelineCompactDiamondsProps extends Pick<
  TimelineLaneBaseProps,
  | "currentTime"
  | "selectedKeyframes"
  | "onClickKeyframe"
  | "onShiftClickKeyframe"
  | "onContextMenuKeyframe"
  | "onMoveKeyframe"
  | "onSelectSegment"
  | "suppressClickRef"
> {
  element: TimelineElement;
  elementId: string;
  keyframesData: TimelineCompactKeyframesData;
  pixelsPerSecond: number;
  rowHeight: number;
  beatsActive: boolean;
  accentColor: string;
  isSelected: boolean;
  rovingTargetId: string | null;
}

/**
 * Project native lanes into the same compact-diamond data contract as the
 * legacy cache. The shared native lane projection merges same-group,
 * same-frame keys deterministically, so collapsed and expanded views expose
 * exactly the same representative native identity.
 */
export function getTimelineNativeCompactKeyframes(
  nativeLanes: readonly NativeTimelinePropertyLane[],
): TimelineCompactKeyframesData {
  return {
    format: "percentage",
    keyframes: getTimelineNativePropertyLanes(nativeLanes)
      .flatMap((lane) => lane.keyframes)
      .sort(
        (left, right) =>
          left.percentage - right.percentage ||
          (left.propertyGroup ?? "").localeCompare(right.propertyGroup ?? "") ||
          (left.native?.parameterId ?? "").localeCompare(right.native?.parameterId ?? "") ||
          (left.native?.keyframeId ?? "").localeCompare(right.native?.keyframeId ?? ""),
      ),
  };
}

/**
 * Build collapsed diamonds using the same property-group authority as the
 * expanded lane renderer. Native migration can be partial, so only legacy
 * keyframes belonging to a supplied native group are removed; legacy rows for
 * unsupported groups remain available in the compact clip bar.
 */
export function mergeTimelineCompactKeyframes(
  legacyKeyframesData: TimelineCompactKeyframesData | undefined,
  nativeLanes: readonly NativeTimelinePropertyLane[],
): TimelineCompactKeyframesData | undefined {
  if (nativeLanes.length === 0) return legacyKeyframesData;
  const nativeKeyframesData = getTimelineNativeCompactKeyframes(nativeLanes);
  if (!legacyKeyframesData) return nativeKeyframesData;

  const nativeGroups = new Set<string>(nativeLanes.map((lane) => lane.propertyGroup));
  const retainedLegacy = legacyKeyframesData.keyframes.flatMap((keyframe) => {
    if (keyframe.propertyGroup != null) {
      return nativeGroups.has(keyframe.propertyGroup) ? [] : [keyframe];
    }
    // Older/mixed GSAP cache rows have no whole-tween group. Split their
    // representative diamond by the groups present in the property bag so a
    // native position lane can replace only position while opacity/effects
    // from the same legacy tween remain visible.
    const groups = new Set(
      Object.keys(keyframe.properties)
        .filter((property) => !NON_ANIMATED_LEGACY_PROPERTIES.has(property))
        .map((property) => classifyPropertyGroup(property)),
    );
    if (groups.size === 0) return [keyframe];
    return [...groups]
      .filter((group) => !nativeGroups.has(group))
      .map((group) => ({ ...keyframe, propertyGroup: group }));
  });
  const keyframes = [...retainedLegacy, ...nativeKeyframesData.keyframes];
  keyframes.sort(
    (left, right) =>
      left.percentage - right.percentage ||
      (left.propertyGroup ?? "").localeCompare(right.propertyGroup ?? "") ||
      (left.animationId ?? "").localeCompare(right.animationId ?? "") ||
      (left.native?.keyframeId ?? "").localeCompare(right.native?.keyframeId ?? ""),
  );
  return { ...legacyKeyframesData, keyframes };
}

/** Inline diamonds shown while the clip's property lanes are collapsed. */
export function TimelineCompactDiamonds({
  element,
  elementId,
  keyframesData,
  pixelsPerSecond,
  rowHeight,
  beatsActive,
  accentColor,
  isSelected,
  currentTime,
  selectedKeyframes,
  rovingTargetId,
  onClickKeyframe,
  onShiftClickKeyframe,
  onContextMenuKeyframe,
  onMoveKeyframe,
  onSelectSegment,
  suppressClickRef,
}: TimelineCompactDiamondsProps) {
  const width = Math.max(element.duration * pixelsPerSecond, 4);
  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: element.start * pixelsPerSecond,
        top: CLIP_Y,
        width,
        height: rowHeight - 2 * CLIP_Y,
        zIndex: isSelected ? 11 : 6,
      }}
    >
      <TimelineClipDiamonds
        keyframesData={keyframesData}
        clipWidthPx={width}
        clipHeightPx={rowHeight - 2 * CLIP_Y}
        beatsActive={beatsActive}
        accentColor={accentColor}
        isSelected={isSelected}
        currentPercentage={
          element.duration > 0 ? ((currentTime - element.start) / element.duration) * 100 : 0
        }
        elementId={elementId}
        clipStart={element.start}
        clipDuration={element.duration}
        selectedKeyframes={selectedKeyframes}
        rovingTargetId={rovingTargetId}
        onClickKeyframe={(_id, target) => onClickKeyframe?.(element, target)}
        onShiftClickKeyframe={onShiftClickKeyframe}
        onContextMenuKeyframe={onContextMenuKeyframe}
        onMoveKeyframe={onMoveKeyframe}
        onSelectSegment={onSelectSegment}
        suppressClickRef={suppressClickRef}
      />
    </div>
  );
}
