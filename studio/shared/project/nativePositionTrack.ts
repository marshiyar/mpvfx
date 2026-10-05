/**
 * Position as one 2D property. A clip may store position either as two scalar
 * tracks (transform.position.x / .y) or as one vec2 track (transform.position);
 * the vec2 form is required for motion paths and auto-rotate, which describe
 * the 2D curve as a whole. Editors keep addressing the familiar x and y
 * parameter IDs; these helpers map them onto a vec2 track when one exists.
 *
 * Evaluation of a vec2 position always goes through the engine as a whole:
 * on a curved path the x of the curve is not an x-only interpolation.
 */
import type { NativeInterpolation, NativeParameterTrack } from "./nativeKeyframeTypes";

export const POSITION_PARAMETER_ID = "transform.position";
export const POSITION_X_PARAMETER_ID = "transform.position.x";
export const POSITION_Y_PARAMETER_ID = "transform.position.y";

export type PositionComponent = "x" | "y";

export function positionComponentOf(parameterId: string): PositionComponent | null {
  if (parameterId === POSITION_X_PARAMETER_ID) return "x";
  if (parameterId === POSITION_Y_PARAMETER_ID) return "y";
  return null;
}

export function positionComponentParameterId(component: PositionComponent): string {
  return component === "x" ? POSITION_X_PARAMETER_ID : POSITION_Y_PARAMETER_ID;
}

export function isVec2PositionTrack(
  track: NativeParameterTrack,
): track is NativeParameterTrack<"vec2"> {
  return track.parameterId === POSITION_PARAMETER_ID && track.valueType === "vec2";
}

export function findVec2PositionTrack(
  tracks: readonly NativeParameterTrack[],
): NativeParameterTrack<"vec2"> | undefined {
  return tracks.find(isVec2PositionTrack);
}

/** One component of a vec2 position, for listing keyframes (never for evaluation). */
export interface PositionComponentView {
  readonly component: PositionComponent;
  readonly parameterId: string;
  readonly keyframes: readonly {
    readonly id: string;
    readonly frame: number;
    readonly value: number;
    readonly outgoing: NativeInterpolation;
  }[];
}

/**
 * Components of a vec2 position not shadowed by a scalar x/y track on the same
 * clip. Rendering lets scalar x/y override the vec2 components and commands
 * edit the scalar track when it exists, so shadowed components are not shown.
 */
export function positionComponentViews(
  track: NativeParameterTrack<"vec2">,
  siblings: readonly NativeParameterTrack[] = [],
): PositionComponentView[] {
  const shadowed = new Set(siblings.map((sibling) => sibling.parameterId));
  return (["x", "y"] as const).filter((component) => !shadowed.has(positionComponentParameterId(component))).map((component) => ({
    component,
    parameterId: positionComponentParameterId(component),
    keyframes: track.keyframes.map((keyframe) => ({
      id: keyframe.id,
      frame: keyframe.frame,
      value: keyframe.value[component],
      outgoing: keyframe.outgoing,
    })),
  }));
}
