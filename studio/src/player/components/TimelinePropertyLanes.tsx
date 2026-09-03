import { useMemo, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import {
  classifyPropertyGroup,
  type GsapAnimation,
  type PropertyGroupName,
} from "@hyperframes/core/gsap-parser";
import { toClipKeyframes } from "../../hooks/gsapShared";
import { synthesizeFlatTweenKeyframes } from "../../hooks/gsapTweenSynth";
import { TimelineDiamondLane, type TimelineDiamondKeyframe } from "./TimelineClipDiamonds";
import { LANE_H, getTimelineLaneTop } from "./timelineLayout";
import type {
  NativeTimelineKeyframeTarget,
  TimelineKeyframeTarget,
} from "./timelineKeyframeIdentity";
import { timelineLogicalRowCellId, timelinePropertyRowId } from "./timelineNavigationIdentity";

/**
 * A projected native parameter track for the timeline UI.  This is deliberately
 * a small, renderer-facing shape rather than a pretend {@link GsapAnimation}:
 * native projects do not have a selector, tween method, or GSAP duration.
 * Percentages are already local to the clip that owns this lane.
 */
export interface NativeTimelineLaneKeyframe {
  id: string;
  percentage: number;
  properties: Record<string, number | string>;
  /** Complete native address used by delete/retime/interpolation commands. */
  native?: NativeTimelineKeyframeTarget;
  /** Populated after coincident scalar channels are merged for rendering. */
  nativeTargets?: readonly NativeTimelineKeyframeTarget[];
  ease?: string;
}

/** A native parameter track projected into one timeline property lane. */
export interface NativeTimelinePropertyLane {
  /** Stable native parameter-track ID, used only as the lane/keyframe target identity. */
  id: string;
  propertyGroup: PropertyGroupName;
  keyframes: readonly NativeTimelineLaneKeyframe[];
}

export interface TimelinePropertyLanesProps {
  /**
   * Id of the wrapper below, so the layer's disclosure caret can point
   * `aria-controls` at the lanes a sighted user sees it reveal. Minted by
   * TimelineLanes, which owns both this subtree and the caret's.
   */
  id: string;
  animations: readonly GsapAnimation[];
  /**
   * Native-project lane projection. Native owns only the property groups it
   * actually supplies; unmatched legacy GSAP groups remain visible/editable.
   * Omitted keeps the legacy GSAP-derived lane path.
   */
  nativeLanes?: readonly NativeTimelinePropertyLane[];
  clipStart: number;
  clipDuration: number;
  clipLeftPx: number;
  clipWidthPx: number;
  effectLaneCount?: number;
  accentColor: string;
  isSelected: boolean;
  currentPercentage: number;
  elementId: string;
  selectedKeyframes: ReadonlySet<string>;
  rovingTargetId?: string | null;
  onSelectSegment?: (target: TimelineKeyframeTarget) => void;
  onClickKeyframe?: (target: TimelineKeyframeTarget) => void;
  onShiftClickKeyframe?: (target: TimelineKeyframeTarget) => void;
  onContextMenuKeyframe?: (e: ReactMouseEvent, target: TimelineKeyframeTarget) => void;
  onMoveKeyframe?: (target: TimelineKeyframeTarget, toClipPercentage: number) => Promise<boolean>;
  suppressClickRef?: RefObject<boolean>;
}

type RenderPropertyLane = {
  group: PropertyGroupName;
  keyframes: TimelineDiamondKeyframe[];
};

/**
 * Keys that ride along in a tween's property bag without being animated: a
 * transform modifier, Studio's internal endpoint marker, and GSAP's reserved
 * `data`. Same exclusion list the parser's classifyTweenPropertyGroup applies —
 * without it `{ x, transformOrigin }` would draw a spurious "Other" lane.
 */
const NON_ANIMATED_PROPERTIES = new Set(["transformOrigin", "_auto", "data"]);

function isAnimatedProperty(property: string): boolean {
  return !NON_ANIMATED_PROPERTIES.has(property);
}

function hasGroupProperty(
  properties: Record<string, number | string>,
  group: PropertyGroupName,
): boolean {
  return Object.keys(properties).some(
    (property) => isAnimatedProperty(property) && classifyPropertyGroup(property) === group,
  );
}

/** Only user-authored keyframes are editable and displayed as diamonds. */
function animationKeyframes(animation: GsapAnimation) {
  return animation.keyframes?.keyframes ?? [];
}

/** Flat tweens still own their property groups for inspector edit routing, but
 * their implicit endpoints are never exposed as authored timeline diamonds. */
function animationRoutingKeyframes(animation: GsapAnimation) {
  return animation.keyframes?.keyframes ?? synthesizeFlatTweenKeyframes(animation)?.keyframes ?? [];
}

/**
 * Every property group a tween draws a lane for, classified PER PROPERTY.
 * `animation.propertyGroup` is the parser's whole-tween verdict and is
 * `undefined` for anything spanning more than one group — but `{ x, opacity }`
 * is the canonical MpVFX entrance tween, and reading that verdict gave it
 * no caret, no reserved row and no diamonds. classifyPropertyGroup is total, so
 * an unrecognised property still lands in "other" rather than vanishing.
 *
 * Single owner: the rendered lanes (sourceGroups) and the reserved row heights
 * (computeLaneCounts) both count groups through here, or they drift.
 */
export function animationLaneGroups(animation: GsapAnimation): PropertyGroupName[] {
  const groups = new Set<PropertyGroupName>();
  for (const keyframe of animationRoutingKeyframes(animation)) {
    for (const property of Object.keys(keyframe.properties)) {
      if (isAnimatedProperty(property)) groups.add(classifyPropertyGroup(property));
    }
  }
  return Array.from(groups);
}

/**
 * Which tween a panel edit to `prop` belongs to.
 *
 * Matches on the groups the tween's KEYFRAMES animate, not on the parser's
 * whole-tween `propertyGroup` verdict: that field is undefined for a legacy
 * mixed tween such as `{ x, opacity }`, so matching it dropped every such
 * tween and sent the edit to the selection's default animation instead, which
 * is a different tween than the lane the user is looking at.
 * {@link animationLaneGroups} is the single owner the rendered lanes count
 * groups through, so resolving here through the same helper keeps the panel
 * and the lanes on one answer.
 */
export function resolveAnimIdForProperty(
  prop: string,
  animations: readonly GsapAnimation[] | undefined,
  fallbackAnimId: string | undefined,
): string {
  const group = classifyPropertyGroup(prop);
  const groupAnim = animations?.find((a) => animationLaneGroups(a).includes(group));
  return groupAnim?.id ?? fallbackAnimId ?? "";
}

/** A tween contributes a property lane when it has authored editable keyframes. */
export function animationContributesLane(animation: GsapAnimation): boolean {
  return animationLaneGroups(animation).length > 0;
}

function sourceGroups(animations: readonly GsapAnimation[]) {
  const groups = new Map<PropertyGroupName, GsapAnimation[]>();
  for (const animation of animations) {
    for (const group of animationLaneGroups(animation)) {
      const groupAnimations = groups.get(group) ?? [];
      groupAnimations.push(animation);
      groups.set(group, groupAnimations);
    }
  }
  return groups;
}

/** Resolve the ease from THIS keyframe's own source tween. A lane can merge
 *  several tweens, so a shared lane-level fallback would label a segment with a
 *  different animation's ease than the one the ease editor targets (it routes
 *  by animationId). */
function keyframeEase(keyframe: { ease?: string }, animation: GsapAnimation): string | undefined {
  return keyframe.ease ?? animation.keyframes?.easeEach ?? animation.ease;
}

/**
 * One lane row per keyframe of `group`. The clip-% re-basing goes through the
 * shared toClipKeyframes so lane rows land on the exact same percentage the
 * keyframe cache writes: this file used to derive it inline and skipped that
 * helper's rounding, which is the one precision every keyframe-cache writer has
 * to agree on (selection keys embed the number).
 */
function groupKeyframes(
  animations: readonly GsapAnimation[],
  group: PropertyGroupName,
  clipStart: number,
  clipDuration: number,
): TimelineDiamondKeyframe[] {
  const keyframes: TimelineDiamondKeyframe[] = [];
  for (const animation of animations) {
    const inGroup = animationKeyframes(animation).filter((keyframe) =>
      hasGroupProperty(keyframe.properties, group),
    );
    for (const keyframe of toClipKeyframes(inGroup, animation, clipStart, clipDuration)) {
      keyframes.push({
        ...keyframe,
        // The LANE's group, not the tween's own classification: a mixed-property
        // tween classifies to undefined yet still feeds every group it touches.
        propertyGroup: group,
        ease: keyframeEase(keyframe, animation),
      });
    }
  }
  return keyframes;
}

export function getTimelinePropertyLanes(
  animations: readonly GsapAnimation[],
  clipStart: number,
  clipDuration: number,
) {
  if (clipDuration <= 0) return [];
  return Array.from(sourceGroups(animations), ([group, groupAnimations]) => ({
    group,
    animations: groupAnimations,
    keyframes: groupKeyframes(groupAnimations, group, clipStart, clipDuration),
  })).filter((lane) => lane.keyframes.length > 0);
}

/**
 * Merge the two timeline authorities at property-group granularity.
 *
 * Native migration is intentionally incremental: a clip may have a native
 * position track while an unsupported opacity/effect track still exists only
 * in the legacy GSAP representation. A clip-wide native switch would hide the
 * latter (and make its edits disappear), so a native lane replaces only its
 * matching group. Group order follows the legacy rows first, then any newly
 * introduced native groups, keeping existing rows from jumping on migration.
 */
export function mergeTimelinePropertyLanes(
  animations: readonly GsapAnimation[],
  nativeLanes: readonly NativeTimelinePropertyLane[],
  clipStart: number,
  clipDuration: number,
): RenderPropertyLane[] {
  const legacy = getTimelinePropertyLanes(animations, clipStart, clipDuration);
  const native = getTimelineNativePropertyLanes(nativeLanes);
  if (native.length === 0) return legacy;

  const nativeByGroup = new Map(native.map((lane) => [lane.group, lane]));
  const legacyByGroup = new Map(legacy.map((lane) => [lane.group, lane]));
  const groups = new Set<PropertyGroupName>([
    ...legacy.map((lane) => lane.group),
    ...native.map((lane) => lane.group),
  ]);
  return [...groups].map((group) => nativeByGroup.get(group) ?? legacyByGroup.get(group)!);
}

/**
 * Convert the neutral native projection to the renderer's diamond data. The
 * legacy-named `animationId` field is a target token consumed by existing
 * selection callbacks; assigning the native track ID here does not construct
 * or imply a GSAP animation.
 */
export function getTimelineNativePropertyLanes(
  nativeLanes: readonly NativeTimelinePropertyLane[],
): RenderPropertyLane[] {
  const groups = new Map<PropertyGroupName, TimelineDiamondKeyframe[]>();
  for (const { id, propertyGroup, keyframes } of nativeLanes) {
    const grouped = groups.get(propertyGroup) ?? [];
    grouped.push(
      ...keyframes.map((keyframe) => ({
          percentage: keyframe.percentage,
          tweenPercentage: keyframe.percentage,
          propertyGroup,
          animationId: id,
          native: keyframe.native,
          nativeTargets: keyframe.nativeTargets,
          properties: keyframe.properties,
          ease: keyframe.ease,
        })),
    );
    groups.set(propertyGroup, grouped);
  }
  return [...groups.entries()]
    .map(([group, keyframes]) => ({
      group,
      keyframes: (() => {
        const sorted = keyframes.sort(
          (left, right) =>
            left.percentage - right.percentage ||
            (left.native?.parameterId ?? "").localeCompare(right.native?.parameterId ?? "") ||
            (left.native?.keyframeId ?? "").localeCompare(right.native?.keyframeId ?? "") ||
            (left.animationId ?? "").localeCompare(right.animationId ?? ""),
        );
        // Canonical native rows carry integer frames, so coincident scalar
        // channels render as one professional group diamond. Address-less
        // neutral callers retain every row: percentage equality alone is not
        // enough evidence that two authored keys are the same frame.
        const byFrame = new Map<number, TimelineDiamondKeyframe>();
        const merged: TimelineDiamondKeyframe[] = [];
        for (const keyframe of sorted) {
          const frame = keyframe.native?.frame;
          if (!Number.isInteger(frame)) {
            merged.push(keyframe);
            continue;
          }
          const existing = byFrame.get(frame!);
          if (!existing) {
            const initial: TimelineDiamondKeyframe = {
              ...keyframe,
            };
            byFrame.set(frame!, initial);
            merged.push(initial);
            continue;
          }
          existing.properties = { ...existing.properties, ...keyframe.properties };
          existing.nativeTargets = [
            ...(existing.nativeTargets ?? (existing.native ? [existing.native] : [])),
            ...(keyframe.nativeTargets ?? (keyframe.native ? [keyframe.native] : [])),
          ];
        }
        return merged;
      })(),
    }))
    .filter(({ keyframes }) => keyframes.length > 0);
}

export function TimelinePropertyLanes({
  id,
  animations,
  nativeLanes,
  clipStart,
  clipDuration,
  clipLeftPx,
  clipWidthPx,
  effectLaneCount = 0,
  accentColor,
  isSelected,
  currentPercentage,
  elementId,
  selectedKeyframes,
  rovingTargetId = null,
  onSelectSegment,
  onClickKeyframe,
  onShiftClickKeyframe,
  onContextMenuKeyframe,
  onMoveKeyframe,
  suppressClickRef,
}: TimelinePropertyLanesProps) {
  // Memoized: TimelineDiamondLane is React.memo'd, and rebuilding the lanes (and
  // a fresh keyframesData literal per lane) on every render would re-render every
  // diamond in every expanded clip on each playhead tick.
  const lanes = useMemo<RenderPropertyLane[]>(
    () =>
      clipWidthPx < 20 || clipDuration <= 0
        ? []
        : nativeLanes === undefined
          ? getTimelinePropertyLanes(animations, clipStart, clipDuration)
          : mergeTimelinePropertyLanes(animations, nativeLanes, clipStart, clipDuration),
    [animations, clipStart, clipDuration, clipWidthPx, nativeLanes],
  );
  const laneData = useMemo(
    () =>
      lanes.map((lane) => ({
        ...lane,
        keyframesData: { format: "percentage" as const, keyframes: lane.keyframes },
      })),
    [lanes],
  );

  // One STATIC wrapper, never `relative`: a static box establishes no containing
  // block, so every absolutely-positioned lane below still resolves against the
  // track-content div and the rendered geometry is byte-identical to the bare
  // fragment this replaced.
  return (
    <div id={id} data-timeline-property-lanes="true">
      {laneData.map(({ group, keyframesData }, laneIndex) => {
        return (
          <div
            key={group}
            id={timelineLogicalRowCellId(id, timelinePropertyRowId(elementId, group), "content")}
            role="group"
            aria-label={`${group} keyframes`}
            data-property-group={group}
            data-timeline-element-id={elementId}
            data-timeline-property-lane=""
            data-timeline-lane-top={getTimelineLaneTop(laneIndex, effectLaneCount)}
            className="absolute"
            style={{
              left: clipLeftPx,
              top: getTimelineLaneTop(laneIndex, effectLaneCount),
              width: clipWidthPx,
              height: LANE_H,
            }}
          >
            <TimelineDiamondLane
              keyframesData={keyframesData}
              clipWidthPx={clipWidthPx}
              clipHeightPx={LANE_H}
              accentColor={accentColor}
              isSelected={isSelected}
              currentPercentage={currentPercentage}
              elementId={elementId}
              clipStart={clipStart}
              clipDuration={clipDuration}
              selectedKeyframes={selectedKeyframes}
              rovingTargetId={rovingTargetId}
              onSelectSegment={onSelectSegment}
              onClickKeyframe={onClickKeyframe}
              onShiftClickKeyframe={onShiftClickKeyframe}
              onContextMenuKeyframe={onContextMenuKeyframe}
              onMoveKeyframe={onMoveKeyframe}
              suppressClickRef={suppressClickRef}
              groupAware
            />
          </div>
        );
      })}
    </div>
  );
}
