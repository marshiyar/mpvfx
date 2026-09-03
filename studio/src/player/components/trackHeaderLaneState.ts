/**
 * Resolves what a property lane's header row shows at the current playhead:
 * which animation owns the lane right now, where the playhead sits inside it,
 * the sampled values, and the add/remove keyframe target. Pure state, no JSX, so
 * the header component only renders what this returns.
 */
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { PropertyGroupName } from "@hyperframes/core/gsap-parser";
import {
  clipToTweenPercentage,
  getKeyframeNavigationState,
} from "../../components/editor/KeyframeNavigation";
import {
  absoluteToPercentageForAnimation,
  isTimeWithinTween,
  resolveTweenDuration,
  resolveTweenStart,
} from "../../utils/globalTimeCompiler";
import type { TimelinePropertyGroupKeyframeToggle } from "./timelineCallbacks";
import { getTimelinePropertyLanes } from "./TimelinePropertyLanes";
import { groupLabel, valuesAt, type LaneValues } from "./trackHeaderLaneValues";
import {
  getTimelineNativePropertyLanes,
  type NativeTimelinePropertyLane,
} from "./TimelinePropertyLanes";
import { evaluateNativeParameterTrack } from "../../project/nativeKeyframeEvaluator";
import type { NativeParameterTrack, RationalFrameRate } from "../../project/nativeKeyframeTypes";
import { projectFrameFromSeconds } from "../../project/nativePropertyEditPlan";
import type { TimelineDiamondKeyframe } from "./timelineDiamondTypes";

export type TimelinePropertyLane = ReturnType<typeof getTimelinePropertyLanes>[number];
export type KeyframeNavigationState = ReturnType<
  typeof getKeyframeNavigationState<TimelinePropertyLane["keyframes"][number]>
>;

function findNearestLaneKeyframe(lane: TimelinePropertyLane, clipPercentage: number) {
  return lane.keyframes.reduce<(typeof lane.keyframes)[number] | null>(
    (nearest, keyframe) =>
      !nearest ||
      Math.abs(keyframe.percentage - clipPercentage) < Math.abs(nearest.percentage - clipPercentage)
        ? keyframe
        : nearest,
    null,
  );
}

function findAnimationAtTime(animations: TimelinePropertyLane["animations"], currentTime: number) {
  return animations.find((candidate) => {
    const start = resolveTweenStart(candidate);
    return start !== null && isTimeWithinTween(currentTime, start, resolveTweenDuration(candidate));
  });
}

function resolveLaneAnimation(
  lane: TimelinePropertyLane,
  navigation: KeyframeNavigationState,
  nearestKeyframe: TimelinePropertyLane["keyframes"][number] | null,
  animationAtPlayhead: GsapAnimation | undefined,
) {
  const animationId = navigation.currentKeyframe?.animationId ?? nearestKeyframe?.animationId;
  return animationAtPlayhead ?? lane.animations.find((candidate) => candidate.id === animationId);
}

function resolveLaneTweenPercentage(
  navigation: KeyframeNavigationState,
  animation: GsapAnimation | undefined,
  animationKeyframes: TimelinePropertyLane["keyframes"],
  currentTime: number,
  clipPercentage: number,
) {
  return (
    navigation.currentKeyframe?.tweenPercentage ??
    (animation ? absoluteToPercentageForAnimation(currentTime, animation) : null) ??
    clipToTweenPercentage(animationKeyframes, clipPercentage)
  );
}

function createLaneToggleTarget(
  animation: GsapAnimation | undefined,
  lane: TimelinePropertyLane,
  tweenPercentage: number,
  values: LaneValues,
  navigation: KeyframeNavigationState,
): TimelinePropertyGroupKeyframeToggle | null {
  return animation
    ? {
        animationId: animation.id,
        propertyGroup: lane.group,
        tweenPercentage,
        properties: values,
        remove: navigation.currentKeyframe !== null,
      }
    : null;
}

export interface LaneHeaderState {
  navigation: KeyframeNavigationState;
  values: LaneValues;
  label: string;
  toggleTarget: TimelinePropertyGroupKeyframeToggle | null;
}

/** Canonical native data needed to evaluate a track header at the playhead. */
export interface NativeTrackHeaderSource {
  frameRate: RationalFrameRate;
  clipStartFrame: number;
  clipDurationFrames: number;
  parameterTracks: readonly NativeParameterTrack[];
}

/** A native lane carries a resolved display state instead of a GSAP animation. */
export interface NativeHeaderPropertyLane {
  group: PropertyGroupName;
  keyframes: TimelineDiamondKeyframe[];
  headerState: LaneHeaderState;
}

const NATIVE_PARAMETER_PROPERTIES: Readonly<Record<string, string>> = {
  "transform.position.x": "x",
  "transform.position.y": "y",
  "transform.position.z": "z",
  "transform.rotation": "rotation",
  "transform.rotationX": "rotationX",
  "transform.rotationY": "rotationY",
  "transform.perspective": "transformPerspective",
  "transform.scale": "scale",
  "transform.scaleX": "scaleX",
  "transform.scaleY": "scaleY",
  "transform.scaleZ": "scaleZ",
  "visual.opacity": "opacity",
  "layout.width": "width",
  "layout.height": "height",
};

/**
 * Build native header rows from actual parameter tracks. Frame conversion is
 * identical to preview/export and the evaluator only accepts an integer frame,
 * preventing a visually plausible but non-deterministic fractional sample.
 */
export function resolveNativeHeaderPropertyLanes(
  nativeLanes: readonly NativeTimelinePropertyLane[],
  source: NativeTrackHeaderSource,
  currentTime: number,
  clipDurationSeconds: number,
): NativeHeaderPropertyLane[] {
  let localFrame: number;
  try {
    localFrame = projectFrameFromSeconds(currentTime, source.frameRate) - source.clipStartFrame;
  } catch {
    return [];
  }
  if (localFrame < 0 || localFrame >= source.clipDurationFrames) return [];

  const valuesByGroup = new Map<PropertyGroupName, LaneValues>();
  for (const track of source.parameterTracks) {
    const property = NATIVE_PARAMETER_PROPERTIES[track.parameterId];
    if (!property || track.valueType !== "number") continue;
    const group =
      property === "x" || property === "y" || property === "z"
        ? "position"
        : property === "rotation" || property === "rotationX" || property === "rotationY" || property === "transformPerspective"
          ? "rotation"
          : property === "scale" || property === "scaleX" || property === "scaleY" || property === "scaleZ"
            ? "scale"
            : property === "opacity"
              ? "visual"
              : "size";
    const values = valuesByGroup.get(group) ?? {};
    values[property] = evaluateNativeParameterTrack(
      track as NativeParameterTrack<"number">,
      localFrame,
    );
    valuesByGroup.set(group, values);
  }

  const clipPercentage =
    clipDurationSeconds > 0 ? ((currentTime - source.clipStartFrame * source.frameRate.denominator / source.frameRate.numerator) / clipDurationSeconds) * 100 : 0;
  return getTimelineNativePropertyLanes(nativeLanes).flatMap((lane) => {
    const values = valuesByGroup.get(lane.group);
    if (!values) return [];
    const navigation = getKeyframeNavigationState(lane.keyframes, clipPercentage, undefined, clipDurationSeconds);
    return [{
      group: lane.group,
      keyframes: lane.keyframes,
      headerState: {
        navigation,
        values,
        label: groupLabel(lane.group, values),
        toggleTarget: null,
      },
    }];
  });
}

export function resolveLaneHeaderState(
  lane: TimelinePropertyLane,
  currentTime: number,
  clipPercentage: number,
  clipDuration?: number,
): LaneHeaderState {
  const navigation = getKeyframeNavigationState(
    lane.keyframes,
    clipPercentage,
    undefined,
    clipDuration,
  );
  const nearestKeyframe = findNearestLaneKeyframe(lane, clipPercentage);
  const animationAtPlayhead = findAnimationAtTime(lane.animations, currentTime);
  const animation = resolveLaneAnimation(lane, navigation, nearestKeyframe, animationAtPlayhead);
  const animationKeyframes = lane.keyframes.filter(
    (keyframe) => keyframe.animationId === animation?.id,
  );
  const tweenPercentage = resolveLaneTweenPercentage(
    navigation,
    animation,
    animationKeyframes,
    currentTime,
    clipPercentage,
  );
  const values = animation ? valuesAt(animation, lane.group, tweenPercentage) : {};

  return {
    navigation,
    values,
    label: groupLabel(lane.group, values),
    toggleTarget: createLaneToggleTarget(animation, lane, tweenPercentage, values, navigation),
  };
}
