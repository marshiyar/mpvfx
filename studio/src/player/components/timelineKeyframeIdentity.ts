import type { AnimationKeyframeTarget } from "../../hooks/gsapTweenSynth";
import type { NativeInterpolation } from "../../project/nativeKeyframeTypes";

/** Complete native command address carried by a rendered project keyframe. */
export interface NativeTimelineKeyframeTarget {
  sequenceId: string;
  trackId: string;
  clipId: string;
  parameterId: string;
  keyframeId: string;
  /** Clip-local integer frame. */
  frame: number;
  /** Total clip frames, used for exact native playhead highlighting. */
  clipDurationFrames?: number;
  /** Whether this keyframe starts an outgoing segment. */
  hasFollowingKeyframe?: boolean;
  /** Authored property bag at this exact native keyframe, used by data actions. */
  properties?: Readonly<Record<string, number | string>>;
  /** Authored interpolation for this keyframe's outgoing segment. */
  outgoing?: NativeInterpolation;
}

export interface TimelineKeyframeTarget {
  percentage: number;
  tweenPercentage?: number;
  propertyGroup?: string;
  animationId?: string;
  /** Present only for native project keyframes; absent means legacy compatibility. */
  native?: NativeTimelineKeyframeTarget;
  /** Every scalar channel represented by one grouped native diamond. */
  nativeTargets?: readonly NativeTimelineKeyframeTarget[];
  collidingAnimationTargets?: AnimationKeyframeTarget[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const parseNativeProperties = (
  value: unknown,
): Readonly<Record<string, number | string>> | null => {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  const properties: Record<string, number | string> = {};
  for (const [property, authoredValue] of entries) {
    if (
      property.trim().length === 0 ||
      (typeof authoredValue !== "string" &&
        (typeof authoredValue !== "number" || !Number.isFinite(authoredValue)))
    ) {
      return null;
    }
    properties[property] = authoredValue;
  }
  return properties;
};

const parseNativeInterpolation = (value: unknown): NativeInterpolation | null => {
  if (!isRecord(value)) return null;
  if (value.type === "hold" || value.type === "linear") return { type: value.type };
  if (value.type !== "cubic-bezier" || !isRecord(value.controlPoints)) return null;
  const { x1, y1, x2, y2 } = value.controlPoints;
  if (
    typeof x1 !== "number" ||
    !Number.isFinite(x1) ||
    x1 < 0 ||
    x1 > 1 ||
    typeof y1 !== "number" ||
    !Number.isFinite(y1) ||
    typeof x2 !== "number" ||
    !Number.isFinite(x2) ||
    x2 < 0 ||
    x2 > 1 ||
    typeof y2 !== "number" ||
    !Number.isFinite(y2)
  ) {
    return null;
  }
  return { type: "cubic-bezier", controlPoints: { x1, y1, x2, y2 } };
};

function parseNativeTarget(value: unknown): NativeTimelineKeyframeTarget | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.sequenceId) ||
    !isNonEmptyString(value.trackId) ||
    !isNonEmptyString(value.clipId) ||
    !isNonEmptyString(value.parameterId) ||
    !isNonEmptyString(value.keyframeId) ||
    typeof value.frame !== "number" ||
    !Number.isInteger(value.frame) ||
    value.frame < 0 ||
    (value.clipDurationFrames !== undefined &&
      (typeof value.clipDurationFrames !== "number" ||
        !Number.isInteger(value.clipDurationFrames) ||
        value.clipDurationFrames <= 0))
  ) {
    return null;
  }
  const properties =
    value.properties === undefined ? undefined : parseNativeProperties(value.properties);
  const outgoing =
    value.outgoing === undefined ? undefined : parseNativeInterpolation(value.outgoing);
  if (value.properties !== undefined && !properties) return null;
  if (value.outgoing !== undefined && !outgoing) return null;
  return {
    sequenceId: value.sequenceId,
    trackId: value.trackId,
    clipId: value.clipId,
    parameterId: value.parameterId,
    keyframeId: value.keyframeId,
    frame: value.frame,
    ...(typeof value.clipDurationFrames === "number"
      ? { clipDurationFrames: value.clipDurationFrames }
      : {}),
    ...(typeof value.hasFollowingKeyframe === "boolean"
      ? { hasFollowingKeyframe: value.hasFollowingKeyframe }
      : {}),
    ...(properties ? { properties } : {}),
    ...(outgoing ? { outgoing } : {}),
  };
}

function parseNativeTargets(value: unknown): readonly NativeTimelineKeyframeTarget[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const targets = value.map(parseNativeTarget);
  return targets.every((target): target is NativeTimelineKeyframeTarget => target !== null)
    ? targets
    : null;
}

/**
 * Note the asymmetry: `tweenPercentage` is optional here and defaults to
 * `percentage`, but the reader treats both slots as authoritative. Callers must
 * therefore keep the pair consistent — writing a new `tweenPercentage` without
 * the matching `percentage` hashes two logically-equal selections to different
 * keys.
 */
export function timelineKeyframeSelectionKey(
  elementId: string,
  target: TimelineKeyframeTarget,
): string {
  if (target.native) {
    const identity: unknown[] = [
      elementId,
      target.propertyGroup ?? "native",
      target.animationId ?? "",
      target.percentage,
      target.tweenPercentage ?? target.percentage,
      target.native,
    ];
    if (target.nativeTargets && target.nativeTargets.length > 0) {
      identity.push(target.nativeTargets);
    }
    return JSON.stringify(identity);
  }
  if (!target.propertyGroup) return `${elementId}:${target.percentage}`;
  return JSON.stringify([
    elementId,
    target.propertyGroup,
    target.animationId ?? "",
    target.percentage,
    target.tweenPercentage ?? target.percentage,
  ]);
}

export function timelineKeyframeTargetFromSelectionKey(
  elementId: string,
  key: string,
): TimelineKeyframeTarget | null {
  if (key.startsWith("[")) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(key);
    } catch {
      return null;
    }
    if (
      !Array.isArray(decoded) ||
      (decoded.length !== 5 && decoded.length !== 6 && decoded.length !== 7)
    ) return null;
    const [selectedElementId, propertyGroup, animationId, percentage, tweenPercentage] = decoded;
    if (
      selectedElementId !== elementId ||
      typeof propertyGroup !== "string" ||
      propertyGroup.length === 0 ||
      typeof animationId !== "string" ||
      typeof percentage !== "number" ||
      !Number.isFinite(percentage) ||
      typeof tweenPercentage !== "number" ||
      !Number.isFinite(tweenPercentage)
    ) {
      return null;
    }
    const native = decoded.length === 6 ? parseNativeTarget(decoded[5]) : null;
    const nativeFromExtendedIdentity = decoded.length === 7 ? parseNativeTarget(decoded[5]) : null;
    const resolvedNative = native ?? nativeFromExtendedIdentity;
    if (decoded.length >= 6 && !resolvedNative) return null;
    const nativeTargets = decoded.length === 7
      ? decoded[6] === null
        ? undefined
        : parseNativeTargets(decoded[6])
      : undefined;
    if (decoded.length === 7 && decoded[6] !== null && !nativeTargets) return null;
    return {
      propertyGroup,
      animationId: animationId || undefined,
      percentage,
      tweenPercentage,
      ...(resolvedNative ? { native: resolvedNative } : {}),
      ...(nativeTargets ? { nativeTargets } : {}),
    };
  }

  const separator = key.lastIndexOf(":");
  if (separator < 0 || key.slice(0, separator) !== elementId) return null;
  const percentage = Number(key.slice(separator + 1));
  return Number.isFinite(percentage) ? { percentage } : null;
}
