/** Resolve displayed timeline diamonds to their native or authored keyframe identity. */
import { isRenderedKeyframeIdentityMatch } from "../animation/GSAP/gsapShared";
import type { NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import type { NativeProjectKeyframeTarget } from "../animation/Keyframe/useNativeProjectKeyframeCommands";
import type {
  NativeTimelineKeyframeTarget, TimelineKeyframeTarget,
} from "../../player/components/timelineKeyframeIdentity";

interface TimelineKeyframeTargetAnimation {
  id: string;
  propertyGroup?: string | null;
  keyframes?: unknown;
}

interface TimelineCachedKeyframe {
  percentage: number;
  tweenPercentage?: number;
  propertyGroup?: string;
  animationId?: string;
}

export function nativeCommandTargetsFromTimelineTargets(
  targets: readonly NativeTimelineKeyframeTarget[],
): readonly NativeProjectKeyframeTarget[] {
  const first = targets[0];
  if (!first) return [];
  if (
    targets.some(
      (target) =>
        target.sequenceId !== first.sequenceId ||
        target.trackId !== first.trackId ||
        target.clipId !== first.clipId ||
        target.frame !== first.frame,
    )
  ) {
    return [];
  }
  return targets.map((native) => ({
    sequenceId: native.sequenceId,
    trackId: native.trackId,
    clipId: native.clipId,
    parameterId: native.parameterId,
    frame: native.frame,
  }));
}

export function nativeCommandTargets(
  target: TimelineKeyframeTarget,
): readonly NativeProjectKeyframeTarget[] | null {
  const nativeTargets = target.nativeTargets?.length
    ? target.nativeTargets
    : target.native
      ? [target.native]
      : null;
  return nativeTargets ? nativeCommandTargetsFromTimelineTargets(nativeTargets) : null;
}

export function nativeClipForTarget(
  document: NativeProjectDocument | null,
  target: NativeProjectKeyframeTarget | undefined,
) {
  if (!document || !target || document.sequence.id !== target.sequenceId) return null;
  const track = document.sequence.tracks.find((candidate) => candidate.id === target.trackId);
  const clip = track?.clips.find((candidate) => candidate.id === target.clipId);
  return clip ?? null;
}

/**
 * Resolve a rendered timeline diamond back to the animation that authored it.
 * Prefer the animation identity carried by the rendered keyframe. Legacy cache
 * entries without one are safe only when their property group has one candidate;
 * ambiguous candidates remain unresolved rather than retiming an arbitrary tween.
 */
export function resolveTimelineKeyframeTarget(
  pct: number,
  keyframes: ReadonlyArray<TimelineCachedKeyframe>,
  animations: ReadonlyArray<TimelineKeyframeTargetAnimation>,
  timing: { start?: number; duration?: number } = {},
): { animId: string; tweenPct: number } | null {
  const rendered = keyframes.find(
    (item) =>
      item.animationId !== undefined &&
      isRenderedKeyframeIdentityMatch(item, { percentage: pct }, timing),
  );
  // A rendered diamond already carries its author identity. Do not let a nearby
  // cache row substitute for it; dense lanes routinely have several per frame.
  if (rendered?.animationId !== undefined) {
    const identifiedAnimation = animations.find((animation) => animation.id === rendered.animationId);
    return identifiedAnimation
      ? { animId: identifiedAnimation.id, tweenPct: rendered.tweenPercentage ?? pct }
      : null;
  }
  const kf = keyframes.find((item) =>
    isRenderedKeyframeIdentityMatch(item, { percentage: pct }, timing),
  );
  if (!kf) return null;
  const identifiedAnimation = kf.animationId
    ? animations.find((animation) => animation.id === kf.animationId)
    : undefined;
  if (kf.animationId) {
    return identifiedAnimation
      ? { animId: identifiedAnimation.id, tweenPct: kf.tweenPercentage ?? pct }
      : null;
  }
  const group = kf?.propertyGroup;
  const candidates = group
    ? animations.filter((animation) => animation.propertyGroup === group)
    : animations.filter((animation) => !animation.propertyGroup);
  const animation = candidates.length === 1 ? candidates[0] : undefined;
  return animation ? { animId: animation.id, tweenPct: kf.tweenPercentage ?? pct } : null;
}
