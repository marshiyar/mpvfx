/**
 * Read-only adapter for the small, authored GSAP subset that has an exact
 * representation in the native project model. It deliberately does not try to
 * "understand" runtime GSAP: anything dynamic or plugin-backed remains
 * legacy-owned. Authored times snap to the project frame they fall in, and an
 * animation reaching outside its clip is cut to the clip by the engine exactly
 * as a trim would cut it.
 */
import type { GsapAnimation, GsapPercentageKeyframe } from "@hyperframes/core/gsap-parser";

import { vkfEngine } from "../../../shared/engine/vkfEngine";
import {
  createNativeParameterTrack,
  validateRationalFrameRate,
  type NativeInterpolation,
  type NativeParameterTrack,
  type RationalFrameRate,
} from "../../../shared/project/nativeKeyframeTypes";

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
  /** Clip length in project frames; when given, keys are cut to the clip. */
  clipDurationFrames?: number;
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
  // GSAP writes numeric width/height as CSS pixels, as native layout does.
  width: { parameterId: "layout.width" },
  height: { parameterId: "layout.height" },
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

type SegmentEase =
  | { readonly kind: "single"; readonly interpolation: NativeInterpolation }
  /** GSAP inOut: the in curve to the midpoint, then the out curve. */
  | { readonly kind: "split"; readonly first: NativeInterpolation; readonly second: NativeInterpolation };

const bezier = (x1: number, y1: number, x2: number, y2: number): NativeInterpolation =>
  ({ type: "cubic-bezier", controlPoints: { x1, y1, x2, y2 } });

// power1 (quad) and power2 (cubic) are polynomials in t, so with X controls at
// 1/3 and 2/3 (x = t) they are exactly these cubic Beziers.
const POWER_CURVES: Readonly<Record<string, { in: NativeInterpolation; out: NativeInterpolation }>> = {
  power1: { in: bezier(1 / 3, 0, 2 / 3, 1 / 3), out: bezier(1 / 3, 2 / 3, 2 / 3, 1) },
  power2: { in: bezier(1 / 3, 0, 2 / 3, 0), out: bezier(1 / 3, 1, 2 / 3, 1) },
};
const POWER_ALIASES: Readonly<Record<string, string>> = { power1: "power1", quad: "power1", power2: "power2", cubic: "power2" };
const NUMBER = String.raw`(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)`;
const CSS_CUBIC = new RegExp(String.raw`^cubic-bezier\(\s*${NUMBER}\s*,\s*${NUMBER}\s*,\s*${NUMBER}\s*,\s*${NUMBER}\s*\)$`, "i");
// Studio's custom(): one cubic segment from (0,0) to (1,1) (see the runtime's
// installStudioCustomEase), which is exactly a CSS cubic-bezier.
const STUDIO_CUSTOM = new RegExp(String.raw`^custom\(\s*M\s*0\s*,\s*0\s+C\s*${NUMBER}\s*,\s*${NUMBER}\s+${NUMBER}\s*,\s*${NUMBER}\s+1\s*,\s*1\s*\)$`, "i");

/**
 * The exact native form of a GSAP ease string, or null when it has none.
 * Callers pass GSAP's own default when the source names no ease, because an
 * omitted ease is not linear in GSAP.
 */
function parseEase(ease: string): SegmentEase | null {
  const name = ease.trim();
  const lower = name.toLowerCase();
  if (LINEAR_EASES.has(lower) || lower === "power0" || lower.startsWith("power0.")) {
    return { kind: "single", interpolation: { type: "linear" } };
  }
  const [family, direction = "out"] = lower.split(".");
  const power = POWER_ALIASES[family ?? ""];
  if (power) {
    const curves = POWER_CURVES[power]!;
    if (direction === "in") return { kind: "single", interpolation: curves.in };
    if (direction === "out") return { kind: "single", interpolation: curves.out };
    if (direction === "inout") return { kind: "split", first: curves.in, second: curves.out };
    return null;
  }
  const match = CSS_CUBIC.exec(name) ?? STUDIO_CUSTOM.exec(name);
  if (!match) return null;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite) || x1! < 0 || x1! > 1 || x2! < 0 || x2! > 1) {
    return null;
  }
  return { kind: "single", interpolation: bezier(x1!, y1!, x2!, y2!) };
}

/** GSAP's inOut value at progress p of a split segment (power1 or power2). */
function splitEaseValue(ease: SegmentEase & { kind: "split" }, progress: number): number {
  const degree = ease.first === POWER_CURVES.power1!.in ? 2 : 3;
  return progress < 0.5
    ? Math.pow(2 * progress, degree) / 2
    : 1 - Math.pow(2 * (1 - progress), degree) / 2;
}

/**
 * Clip-local project frame of an authored time. HTML timing is continuous while
 * the native project is frame-based, so a time maps to the project frame it
 * falls in: the same floor rule the bootstrap uses to adopt clip starts and
 * durations. An animation authored at its clip's start therefore stays at local
 * frame 0 even when neither lands exactly on a frame boundary. Negative frames
 * (before the clip) are cut away later by cutToClip.
 */
function frameAtSeconds(
  seconds: number,
  clipStartSeconds: number,
  frameRate: RationalFrameRate,
): number | null {
  if (!Number.isFinite(seconds) || !Number.isFinite(clipStartSeconds)) return null;
  const absolute = Math.floor((seconds * frameRate.numerator) / frameRate.denominator + EPSILON);
  const clipStart = Math.round((clipStartSeconds * frameRate.numerator) / frameRate.denominator);
  const local = absolute - clipStart;
  return Number.isSafeInteger(local) ? local : null;
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
  /** GSAP ease of the segment arriving at this stop (defaults resolved). */
  ease?: string;
};

// GSAP's defaults: a tween eases power1.out, and each segment of percentage
// keyframes eases power1.inOut unless easeEach or the key names one.
const DEFAULT_TWEEN_EASE = "power1.out";
const DEFAULT_KEYFRAME_EASE = "power1.inOut";

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
      { frame: startFrame, values: start.values },
      { frame: endFrame, values: end.values, ease: animation.ease ?? DEFAULT_TWEEN_EASE },
    ],
  };
}

function stopsFromKeyframes(
  animation: GsapAnimation,
  keyframeFrame: (percentage: number) => number | null,
): { ok: true; stops: ScalarStop[] } | { ok: false; reason: LegacyGsapImportReason; message: string } {
  const keys = animation.keyframes?.keyframes;
  if (!keys || keys.length === 0) {
    return { ok: false, reason: "invalid-keyframes", message: "Missing explicit percentage keyframes" };
  }
  // A tween-level ease re-times the whole keyframe run, which no per-segment
  // native interpolation can express.
  if (animation.ease !== undefined && !LINEAR_EASES.has(animation.ease.trim().toLowerCase())) {
    return { ok: false, reason: "unsupported-ease", message: "An ease over a whole keyframe run has no native equivalent" };
  }
  const frames = new Set<number>();
  let expectedKeys: Record<string, number> | null = null;
  const stops: ScalarStop[] = [];
  for (const keyframe of keys as GsapPercentageKeyframe[]) {
    if (!Number.isFinite(keyframe.percentage) || keyframe.percentage < 0 || keyframe.percentage > 100) {
      return { ok: false, reason: "invalid-keyframes", message: "Keyframe percentage must be between 0 and 100" };
    }
    const frame = keyframeFrame(keyframe.percentage);
    if (frame === null) {
      return { ok: false, reason: "off-frame-timing", message: "Percentage keyframe does not land on a clip-local project frame" };
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
    stops.push({ frame, values: properties.values, ease: keyframe.ease ?? animation.keyframes?.easeEach ?? DEFAULT_KEYFRAME_EASE });
  }
  stops.sort((left, right) => left.frame - right.frame);
  return { ok: true, stops };
}

/**
 * Keep only the part of a clip-local track inside [0, clipDurationFrames]. The
 * track is built shifted so its first key is at frame 0 or later (the engine
 * works on non-negative frames), then sliced exactly; a cut point gets a
 * generated key carrying the value and timing the original had there.
 */
function cutToClip(
  track: NativeParameterTrack<"number">,
  shift: number,
  clipDurationFrames: number | undefined,
): NativeParameterTrack {
  const lastFrame = track.keyframes[track.keyframes.length - 1]!.frame;
  const until = clipDurationFrames === undefined
    ? Math.max(lastFrame, shift) + 1
    : shift + clipDurationFrames + 1;
  if (shift === 0 && lastFrame < until) return track;
  const authoredIdByFrame = new Map(track.keyframes.map((key) => [key.frame, key.id]));
  const keyframes = vkfEngine().slice(track, shift, until).map((key) => ({
    id: (!key.generated && authoredIdByFrame.get(key.sourceFrame)) || `${track.id}:cut:${key.frame}`,
    frame: key.frame,
    value: key.value as number,
    outgoing: key.outgoing,
  }));
  return createNativeParameterTrack({
    id: track.id,
    parameterId: track.parameterId,
    valueType: "number",
    frameRate: track.frameRate,
    keyframes,
  });
}

/**
 * Native keys for the stops: each key's outgoing interpolation is the ease of
 * the segment it starts. An inOut segment becomes two keys meeting at its
 * midpoint (the in curve, then the out curve); the midpoint snaps to the
 * project frame it falls in, like every other authored time.
 */
function withOutgoingInterpolation(
  stops: readonly ScalarStop[],
): { frame: number; values: Record<string, number>; outgoing: NativeInterpolation }[] | null {
  const timed: { frame: number; values: Record<string, number>; outgoing: NativeInterpolation }[] = [];
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index]!;
    const next = stops[index + 1];
    if (!next) {
      timed.push({ frame: stop.frame, values: stop.values, outgoing: { type: "linear" } });
      break;
    }
    const ease = parseEase(next.ease ?? "none");
    if (!ease) return null;
    if (ease.kind === "single") {
      timed.push({ frame: stop.frame, values: stop.values, outgoing: ease.interpolation });
      continue;
    }
    const middle = Math.floor((stop.frame + next.frame) / 2);
    if (middle <= stop.frame) {
      // One frame apart: only the two ends are ever rendered.
      timed.push({ frame: stop.frame, values: stop.values, outgoing: ease.second });
      continue;
    }
    const progress = splitEaseValue(ease, (middle - stop.frame) / (next.frame - stop.frame));
    const values: Record<string, number> = {};
    for (const [name, from] of Object.entries(stop.values)) {
      values[name] = from + (next.values[name]! - from) * progress;
    }
    timed.push({ frame: stop.frame, values: stop.values, outgoing: ease.first });
    timed.push({ frame: middle, values, outgoing: ease.second });
  }
  return timed;
}

function tracksFromStops(
  clipId: string,
  animation: GsapAnimation,
  frameRate: RationalFrameRate,
  stops: ScalarStop[],
  clipDurationFrames: number | undefined,
): Conversion {
  const shift = Math.max(0, -Math.min(...stops.map((stop) => stop.frame)));
  const timed = withOutgoingInterpolation(stops);
  if (!timed) {
    return { ok: false, reason: "unsupported-ease", message: "GSAP easing has no exact native interpolation mapping" };
  }
  const names = Object.keys(stops[0]?.values ?? {}).sort();
  const tracks: NativeParameterTrack[] = [];
  for (const name of names) {
    const mapped = PROPERTIES[name];
    if (!mapped) return { ok: false, reason: "unsupported-property", message: `Property ${name} has no native equivalent` };
    const keyframes = timed.map((stop) => ({
      id: `native:${clipId}:legacy:${animation.id}:${mapped.parameterId}:frame:${stop.frame}`,
      frame: stop.frame + shift,
      value: stop.values[name]!,
      outgoing: stop.outgoing,
    }));
    try {
      const track = createNativeParameterTrack({
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
      });
      tracks.push(cutToClip(track, shift, clipDurationFrames));
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
  clipDurationFrames: number | undefined,
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
    return { ok: false, reason: "invalid-timing", message: "Start time is not a finite project frame" };
  }
  const zeroDuration = animation.method === "set" || animation.duration === 0;
  if (zeroDuration) {
    const properties = validProperties(animation.properties);
    if (!properties.ok) return properties;
    return tracksFromStops(clipId, animation, frameRate, [{ frame: startFrame, values: properties.values }], clipDurationFrames);
  }
  if (typeof animation.duration !== "number" || !Number.isFinite(animation.duration) || animation.duration <= 0) {
    return { ok: false, reason: "invalid-timing", message: "Tween duration must be a positive finite literal" };
  }
  const duration = animation.duration;
  const endFrame = frameAtSeconds(startSeconds + duration, clipStartSeconds, frameRate);
  if (endFrame === null || endFrame <= startFrame) {
    return { ok: false, reason: "off-frame-timing", message: "Tween is shorter than one project frame" };
  }
  const stops = animation.keyframes
    ? stopsFromKeyframes(animation, (percentage) =>
        frameAtSeconds(startSeconds + (duration * percentage) / 100, clipStartSeconds, frameRate))
    : stopsFromFlat(animation, startFrame, endFrame);
  if (!stops.ok) return stops;
  return tracksFromStops(clipId, animation, frameRate, stops.stops, clipDurationFrames);
}

/**
 * Convert only exact, literal GSAP animations. Each input animation becomes its
 * own native tracks; no source animations or property groups are ever merged.
 */
export function adaptLegacyGsapAnimations(
  input: LegacyGsapKeyframeAdapterInput,
): LegacyGsapKeyframeAdapterResult {
  const result: LegacyGsapKeyframeAdapterResult = { nativeTracks: [], legacyOnly: [], diagnostics: [] };
  let validContext = typeof input.clipId === "string" && input.clipId.trim().length > 0 && Number.isFinite(input.clipStartSeconds) &&
    (input.clipDurationFrames === undefined || (Number.isSafeInteger(input.clipDurationFrames) && input.clipDurationFrames > 0));
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
    const converted = failed ?? convertAnimation(input.clipId, input.clipStartSeconds, input.clipDurationFrames, input.frameRate, animation);
    if (converted.ok) {
      result.nativeTracks.push(...converted.tracks);
    } else {
      result.legacyOnly.push(animation);
      result.diagnostics.push(diagnostic(animation, converted.reason, converted.message));
    }
  }
  return result;
}
