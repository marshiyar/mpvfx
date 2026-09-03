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
  const clipLocalFrame = projectFrame - clip.startFrame;
  if (clipLocalFrame < 0 || clipLocalFrame >= clip.durationFrames) {
    return failure(
      "playhead-outside-clip",
      `Project frame ${projectFrame} is outside clip ${clip.id}`,
    );
  }

  const currentValues: Partial<Record<NativeKeyframeUiProperty, number>> = {};
  const keyframeRows: NativeKeyframeUiRow[] = [];
  // Static clip values are the authored base state. Parameter tracks override
  // only the property they own; unanimated native values remain visible in the
  // inspector without being misrepresented as keyframes.
  for (const projection of PARAMETER_PROJECTIONS) {
    const value = clip.staticParameters?.[projection.parameterId];
    if (typeof value === "number") currentValues[projection.property] = value;
  }
  for (const { track, projection } of supportedTracks(clip.parameterTracks)) {
    currentValues[projection.property] = evaluateNativeParameterTrack(track, clipLocalFrame);
    for (const keyframe of track.keyframes) {
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
