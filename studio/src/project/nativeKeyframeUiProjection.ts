import { evaluateNativeParameterTrack } from "./nativeKeyframeEvaluator";
import type { NativeInterpolation, NativeParameterTrack } from "./nativeKeyframeTypes";
import type { NativeProjectDocument } from "./nativeProjectDocument";
import {
  projectFrameFromSeconds,
  resolveNativeClipSelection,
  type NativePropertyEditPlanFailure,
  type NativeSelectedElementReference,
} from "./nativePropertyEditPlan";

export type NativeKeyframeUiProperty =
  | "x"
  | "y"
  | "z"
  | "rotation"
  | "scale"
  | "scaleX"
  | "scaleY"
  | "scaleZ"
  | "rotationX"
  | "rotationY"
  | "transformPerspective"
  | "opacity"
  | "width"
  | "height";

export interface NativeKeyframeUiRow {
  readonly percentage: number;
  readonly properties: Readonly<Partial<Record<NativeKeyframeUiProperty, number>>>;
  /** Compatible navigation identity: the canonical native parameter-track ID. */
  readonly animationId: string;
  readonly parameterId: string;
  readonly nativeKeyframeId: string;
  readonly nativeFrame: number;
  readonly interpolation: NativeInterpolation;
}

export interface NativeKeyframeUiProjectionRequest {
  readonly selectedElement: NativeSelectedElementReference;
  readonly playheadSeconds: number;
}

export type NativeKeyframeUiProjectionResult =
  | {
      readonly ok: true;
      readonly sequenceId: string;
      readonly trackId: string;
      readonly clipId: string;
      readonly clipStartSeconds: number;
      readonly clipDurationSeconds: number;
      readonly projectFrame: number;
      readonly clipLocalFrame: number;
      readonly currentValues: Readonly<Partial<Record<NativeKeyframeUiProperty, number>>>;
      readonly keyframeRows: readonly NativeKeyframeUiRow[];
    }
  | { readonly ok: false; readonly failure: NativePropertyEditPlanFailure };

interface ParameterProjection {
  readonly parameterId: string;
  readonly property: NativeKeyframeUiProperty;
}

const PARAMETER_PROJECTIONS: readonly ParameterProjection[] = [
  { parameterId: "transform.position.x", property: "x" },
  { parameterId: "transform.position.y", property: "y" },
  { parameterId: "transform.position.z", property: "z" },
  { parameterId: "transform.rotation", property: "rotation" },
  { parameterId: "transform.rotationX", property: "rotationX" },
  { parameterId: "transform.rotationY", property: "rotationY" },
  { parameterId: "transform.scale", property: "scale" },
  { parameterId: "transform.scaleX", property: "scaleX" },
  { parameterId: "transform.scaleY", property: "scaleY" },
  { parameterId: "transform.scaleZ", property: "scaleZ" },
  { parameterId: "transform.perspective", property: "transformPerspective" },
  { parameterId: "visual.opacity", property: "opacity" },
  { parameterId: "layout.width", property: "width" },
  { parameterId: "layout.height", property: "height" },
];

const projectionByParameterId = new Map(
  PARAMETER_PROJECTIONS.map((projection, index) => [
    projection.parameterId,
    { ...projection, order: index },
  ]),
);

const cloneInterpolation = (interpolation: NativeInterpolation): NativeInterpolation =>
  interpolation.type === "cubic-bezier"
    ? { type: interpolation.type, controlPoints: { ...interpolation.controlPoints } }
    : { type: interpolation.type };

const failure = (
  code: NativePropertyEditPlanFailure["code"],
  message: string,
): NativeKeyframeUiProjectionResult => ({ ok: false, failure: { code, message } });

const supportedTracks = (tracks: readonly NativeParameterTrack[]) =>
  tracks
    .flatMap((track) => {
      const projection = projectionByParameterId.get(track.parameterId);
      if (!projection || track.valueType !== "number") return [];
      return [{ track: track as NativeParameterTrack<"number">, projection }];
    })
    .sort(
      (left, right) =>
        left.projection.order - right.projection.order || left.track.id.localeCompare(right.track.id),
    );

/**
 * Project native clip state into the legacy-shaped navigation rows consumed by
 * editor chrome. Canonical values and interpolation remain native-owned.
 */
export const projectNativeKeyframeUi = (
  document: NativeProjectDocument,
  request: NativeKeyframeUiProjectionRequest,
): NativeKeyframeUiProjectionResult => {
  const resolution = resolveNativeClipSelection(document, request.selectedElement);
  if (!resolution.ok) return { ok: false, failure: resolution.failure };
  const { clip, trackId } = resolution.located;

  let projectFrame: number;
  try {
    projectFrame = projectFrameFromSeconds(request.playheadSeconds, document.frameRate);
  } catch (error) {
    return failure(
      "invalid-playhead",
      error instanceof Error ? error.message : "The playhead time is invalid",
    );
  }
  // Selection inspection is independent of playback visibility. Match property
  // editing at the nearest visible clip frame so values and diamonds stay valid.
  const clipLocalFrame = Math.max(0, Math.min(clip.durationFrames - 1, projectFrame - clip.startFrame));

  const currentValues: Partial<Record<NativeKeyframeUiProperty, number>> = {};
  const keyframeRows: NativeKeyframeUiRow[] = [];
  // Static clip values are the authored base state. Parameter tracks override
  // only the property they own; unanimated native values remain visible in the
  // inspector without being misrepresented as keyframes.
  const position = clip.staticParameters?.["transform.position"];
  if (position && typeof position === "object" && "x" in position && "y" in position) {
    currentValues.x = position.x;
    currentValues.y = position.y;
  }
  const scale = clip.staticParameters?.["transform.scale"];
  if (scale && typeof scale === "object" && "x" in scale && "y" in scale) {
    currentValues.scaleX = scale.x;
    currentValues.scaleY = scale.y;
    if (scale.x === scale.y) currentValues.scale = scale.x;
  }
  for (const projection of PARAMETER_PROJECTIONS) {
    const value = clip.staticParameters?.[projection.parameterId];
    if (typeof value === "number") currentValues[projection.property] = value;
  }
  for (const { track, projection } of supportedTracks(clip.parameterTracks)) {
    currentValues[projection.property] = evaluateNativeParameterTrack(track, clipLocalFrame);
    for (const keyframe of track.keyframes) {
      if (keyframe.frame < 0 || keyframe.frame >= clip.durationFrames) continue;
      keyframeRows.push({
        percentage: (keyframe.frame / clip.durationFrames) * 100,
        properties: { [projection.property]: keyframe.value },
        animationId: track.id,
        parameterId: track.parameterId,
        nativeKeyframeId: keyframe.id,
        nativeFrame: keyframe.frame,
        interpolation: cloneInterpolation(keyframe.outgoing),
      });
    }
  }

  const secondsPerFrame = document.frameRate.denominator / document.frameRate.numerator;
  return {
    ok: true,
    sequenceId: document.sequence.id,
    trackId,
    clipId: clip.id,
    clipStartSeconds: clip.startFrame * secondsPerFrame,
    clipDurationSeconds: clip.durationFrames * secondsPerFrame,
    projectFrame,
    clipLocalFrame,
    currentValues,
    keyframeRows,
  };
};
