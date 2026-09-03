/**
 * Read-only adapter for the small, authored GSAP subset that has an exact
 * representation in the native project model. It deliberately does not try to
 * "understand" runtime GSAP: anything dynamic, plugin-backed, or off the
 * project's frame grid remains legacy-owned.
 */
import type { GsapAnimation, GsapPercentageKeyframe } from "@hyperframes/core/gsap-parser";

import {
  createNativeParameterTrack,
  validateRationalFrameRate,
  type NativeInterpolation,
  type NativeParameterTrack,
  type RationalFrameRate,
} from "./nativeKeyframeTypes";

export type LegacyGsapImportReason =
  | "invalid-context"
  | "duplicate-animation-id"
  | "non-literal-provenance"
  | "dynamic-selector"
  | "dynamic-keyframes"
  | "unsupported-plugin-or-extra"
  | "unsupported-property"
  | "unsupported-ease"
  | "missing-authored-baseline"
  | "invalid-timing"
  | "off-frame-timing"
  | "invalid-keyframes"
  | "non-finite-value";

export interface LegacyGsapImportDiagnostic {
  animationId: string;
  reason: LegacyGsapImportReason;
  message: string;
}

export interface LegacyGsapKeyframeAdapterResult {
  nativeTracks: NativeParameterTrack[];
  legacyOnly: GsapAnimation[];
  diagnostics: LegacyGsapImportDiagnostic[];
}

export interface LegacyGsapKeyframeAdapterInput {
  /** Stable native clip identity; selector text is never used as an output id. */
  clipId: string;
  /** Project seconds at which this clip begins. */
  clipStartSeconds: number;
  frameRate: RationalFrameRate;
  animations: readonly GsapAnimation[];
}

type ScalarProperty = {
  parameterId: string;
};

const PROPERTIES: Readonly<Record<string, ScalarProperty>> = {
  x: { parameterId: "transform.position.x" },
  y: { parameterId: "transform.position.y" },
  z: { parameterId: "transform.position.z" },
  rotation: { parameterId: "transform.rotation" },
  rotationZ: { parameterId: "transform.rotation" },
  rotationX: { parameterId: "transform.rotationX" },
  rotationY: { parameterId: "transform.rotationY" },
  scale: { parameterId: "transform.scale" },
  scaleX: { parameterId: "transform.scaleX" },
  scaleY: { parameterId: "transform.scaleY" },
  scaleZ: { parameterId: "transform.scaleZ" },
  perspective: { parameterId: "transform.perspective" },
  transformPerspective: { parameterId: "transform.perspective" },
  opacity: { parameterId: "visual.opacity" },
  autoAlpha: { parameterId: "visual.autoAlpha" },
};

const LINEAR_EASES = new Set(["none", "linear"]);
const EPSILON = 1e-8;

function diagnostic(
  animation: GsapAnimation,
  reason: LegacyGsapImportReason,
  message: string,
): LegacyGsapImportDiagnostic {
  return { animationId: animation.id, reason, message };
}

function parseEase(ease: string | undefined): NativeInterpolation | null {
  if (ease === undefined || LINEAR_EASES.has(ease.trim().toLowerCase())) {
    return { type: "linear" };
  }
  const match = /^cubic-bezier\(\s*(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*\)$/i.exec(
    ease.trim(),
  );
  if (!match) return null;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
    return null;
  }
  return { type: "cubic-bezier", controlPoints: { x1, y1, x2, y2 } };
}

function frameAtSeconds(
  seconds: number,
  clipStartSeconds: number,
  frameRate: RationalFrameRate,
): number | null {
  if (!Number.isFinite(seconds) || !Number.isFinite(clipStartSeconds)) return null;
  const frames = ((seconds - clipStartSeconds) * frameRate.numerator) / frameRate.denominator;
  if (!Number.isFinite(frames) || frames < -EPSILON) return null;
  const rounded = Math.round(frames);
  return Math.abs(frames - rounded) <= EPSILON ? Math.max(0, rounded) : null;
}

function resolvedStart(animation: GsapAnimation): number | null {
  if (typeof animation.resolvedStart === "number" && Number.isFinite(animation.resolvedStart)) {
    return animation.resolvedStart;
  }
  if (animation.method === "set" || animation.duration === 0) {
    if (typeof animation.position === "number" && Number.isFinite(animation.position)) {
      return animation.position;
    }
    return 0;
  }
  return null;
}

type ScalarStop = {
  frame: number;
  values: Record<string, number>;
  ease?: string;
};

type Conversion =
  | { ok: true; tracks: NativeParameterTrack[] }
  | { ok: false; reason: LegacyGsapImportReason; message: string };

type ValidProperties =
  | { ok: true; values: Record<string, number> }
  | { ok: false; reason: LegacyGsapImportReason; message: string };

function validProperties(properties: Record<string, number | string>): ValidProperties {
  const values: Record<string, number> = {};
  const keys = Object.keys(properties);
  if (keys.length === 0) {
    return { ok: false, reason: "invalid-keyframes", message: "Animation has no authored properties" };
  }
  for (const key of keys) {
    if (!(key in PROPERTIES)) {
      return { ok: false, reason: "unsupported-property", message: `Property ${key} has no native equivalent` };
    }
    const value = properties[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, reason: "non-finite-value", message: `Property ${key} must be a finite literal number` };
    }
    values[key] = value;
  }
  return { ok: true, values };
}

function samePropertyKeys(first: Record<string, number>, second: Record<string, number>): boolean {
  const a = Object.keys(first).sort();
  const b = Object.keys(second).sort();
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function stopsFromFlat(
  animation: GsapAnimation,
  startFrame: number,
  endFrame: number,
): { ok: true; stops: ScalarStop[] } | { ok: false; reason: LegacyGsapImportReason; message: string } {
  const destination = validProperties(animation.properties);
  if (!destination.ok) return destination;
  const baselineSource = animation.method === "from" ? animation.fromProperties : animation.fromProperties;
  const startSource = animation.method === "from" ? animation.properties : baselineSource;
  const endSource = animation.method === "from" ? baselineSource : animation.properties;
  if (!startSource || !endSource) {
    return {
      ok: false,
      reason: "missing-authored-baseline",
      message: `${animation.method} requires explicit authored start and end values for native import`,
    };
  }
  const start = validProperties(startSource);
  if (!start.ok) return start;
  const end = validProperties(endSource);
  if (!end.ok) return end;
  if (!samePropertyKeys(start.values, end.values)) {
    return {
      ok: false,
      reason: "invalid-keyframes",
      message: "Authored start and end property sets must match exactly",
    };
  }
  return {
    ok: true,
    stops: [
      { frame: startFrame, values: start.values, ease: animation.ease },
      { frame: endFrame, values: end.values },
    ],
  };
}

function stopsFromKeyframes(
  animation: GsapAnimation,
  startFrame: number,
  durationFrames: number,
): { ok: true; stops: ScalarStop[] } | { ok: false; reason: LegacyGsapImportReason; message: string } {
  const keys = animation.keyframes?.keyframes;
  if (!keys || keys.length === 0) {
    return { ok: false, reason: "invalid-keyframes", message: "Missing explicit percentage keyframes" };
  }
  const frames = new Set<number>();
  let expectedKeys: Record<string, number> | null = null;
  const stops: ScalarStop[] = [];
  for (const keyframe of keys as GsapPercentageKeyframe[]) {
    if (!Number.isFinite(keyframe.percentage) || keyframe.percentage < 0 || keyframe.percentage > 100) {
      return { ok: false, reason: "invalid-keyframes", message: "Keyframe percentage must be between 0 and 100" };
    }
    const absoluteFrame = startFrame + (durationFrames * keyframe.percentage) / 100;
    const frame = Math.round(absoluteFrame);
    if (Math.abs(absoluteFrame - frame) > EPSILON) {
      return { ok: false, reason: "off-frame-timing", message: "Percentage keyframe does not land on a project frame" };
    }
    if (frames.has(frame)) {
      return { ok: false, reason: "invalid-keyframes", message: "Multiple keyframes land on one project frame" };
    }
    frames.add(frame);
    const properties = validProperties(keyframe.properties);
    if (!properties.ok) return properties;
    if (expectedKeys && !samePropertyKeys(expectedKeys, properties.values)) {
      return { ok: false, reason: "invalid-keyframes", message: "Every keyframe must explicitly author the same properties" };
    }
    expectedKeys = properties.values;
    stops.push({ frame, values: properties.values, ease: keyframe.ease ?? animation.keyframes?.easeEach ?? animation.ease });
  }
  stops.sort((left, right) => left.frame - right.frame);
  return { ok: true, stops };
}

function tracksFromStops(
  clipId: string,
  animation: GsapAnimation,
  frameRate: RationalFrameRate,
  stops: ScalarStop[],
): Conversion {
  const names = Object.keys(stops[0]?.values ?? {}).sort();
  const tracks: NativeParameterTrack[] = [];
  for (const name of names) {
    const mapped = PROPERTIES[name];
    if (!mapped) return { ok: false, reason: "unsupported-property", message: `Property ${name} has no native equivalent` };
    const keyframes = stops.map((stop, index) => {
      const interpolation = index === stops.length - 1 ? { type: "linear" as const } : parseEase(stop.ease);
      if (!interpolation) return null;
      return {
        id: `native:${clipId}:legacy:${animation.id}:${mapped.parameterId}:frame:${stop.frame}`,
        frame: stop.frame,
        value: stop.values[name]!,
        outgoing: interpolation,
      };
    });
    if (keyframes.some((keyframe) => keyframe === null)) {
      return { ok: false, reason: "unsupported-ease", message: "GSAP easing has no exact native interpolation mapping" };
    }
    try {
      tracks.push(
        createNativeParameterTrack({
          id: `native:${clipId}:legacy:${animation.id}:${mapped.parameterId}`,
          parameterId: mapped.parameterId,
          valueType: "number",
          frameRate,
          keyframes: keyframes as Array<{
            id: string;
            frame: number;
            value: number;
            outgoing: NativeInterpolation;
          }>,
        }),
      );
    } catch (error) {
      return {
        ok: false,
        reason: "invalid-keyframes",
        message: error instanceof Error ? error.message : "Native keyframe validation failed",
      };
    }
  }
  return { ok: true, tracks };
}

function convertAnimation(
  clipId: string,
  clipStartSeconds: number,
  frameRate: RationalFrameRate,
  animation: GsapAnimation,
): Conversion {
  if (animation.provenance && animation.provenance.kind !== "literal") {
    return { ok: false, reason: "non-literal-provenance", message: "Only literal source animations are portable" };
  }
  if (animation.hasUnresolvedSelector) {
    return { ok: false, reason: "dynamic-selector", message: "Dynamic selector has no stable source mapping" };
  }
  if (animation.hasUnresolvedKeyframes) {
    return { ok: false, reason: "dynamic-keyframes", message: "Dynamic keyframes cannot be imported exactly" };
  }
  if (animation.arcPath || (animation.extras && Object.keys(animation.extras).length > 0)) {
    return { ok: false, reason: "unsupported-plugin-or-extra", message: "Plugins and extra GSAP behavior remain legacy-owned" };
  }
  const startSeconds = resolvedStart(animation);
  if (startSeconds === null || startSeconds < 0) {
    return { ok: false, reason: "invalid-timing", message: "Animation requires a finite resolved start time" };
  }
  const startFrame = frameAtSeconds(startSeconds, clipStartSeconds, frameRate);
  if (startFrame === null) {
    return { ok: false, reason: "off-frame-timing", message: "Start time does not land on a clip-local project frame" };
  }
  const zeroDuration = animation.method === "set" || animation.duration === 0;
  if (zeroDuration) {
    const properties = validProperties(animation.properties);
    if (!properties.ok) return properties;
    return tracksFromStops(clipId, animation, frameRate, [{ frame: startFrame, values: properties.values }]);
  }
  if (typeof animation.duration !== "number" || !Number.isFinite(animation.duration) || animation.duration <= 0) {
    return { ok: false, reason: "invalid-timing", message: "Tween duration must be a positive finite literal" };
  }
  const endFrame = frameAtSeconds(startSeconds + animation.duration, clipStartSeconds, frameRate);
  if (endFrame === null || endFrame <= startFrame) {
    return { ok: false, reason: "off-frame-timing", message: "Tween duration does not land on a later project frame" };
  }
  const stops = animation.keyframes
    ? stopsFromKeyframes(animation, startFrame, endFrame - startFrame)
    : stopsFromFlat(animation, startFrame, endFrame);
  if (!stops.ok) return stops;
  return tracksFromStops(clipId, animation, frameRate, stops.stops);
}

/**
 * Convert only exact, literal GSAP animations. Each input animation becomes its
 * own native tracks; no source animations or property groups are ever merged.
 */
export function adaptLegacyGsapAnimations(
  input: LegacyGsapKeyframeAdapterInput,
): LegacyGsapKeyframeAdapterResult {
  const result: LegacyGsapKeyframeAdapterResult = { nativeTracks: [], legacyOnly: [], diagnostics: [] };
  let validContext = typeof input.clipId === "string" && input.clipId.trim().length > 0 && Number.isFinite(input.clipStartSeconds);
  try {
    validateRationalFrameRate(input.frameRate);
  } catch {
    validContext = false;
  }
  const idCounts = new Map<string, number>();
  for (const animation of input.animations) idCounts.set(animation.id, (idCounts.get(animation.id) ?? 0) + 1);

  for (const animation of input.animations) {
    let failed: Conversion | null = null;
    if (!validContext) {
      failed = { ok: false, reason: "invalid-context", message: "Clip ID, clip start, and rational project frame rate are required" };
    } else if (!animation.id || (idCounts.get(animation.id) ?? 0) > 1) {
      failed = { ok: false, reason: "duplicate-animation-id", message: "Animation ID must be unique for stable native IDs" };
    }
    const converted = failed ?? convertAnimation(input.clipId, input.clipStartSeconds, input.frameRate, animation);
    if (converted.ok) {
      result.nativeTracks.push(...converted.tracks);
    } else {
      result.legacyOnly.push(animation);
      result.diagnostics.push(diagnostic(animation, converted.reason, converted.message));
    }
  }
  return result;
}
