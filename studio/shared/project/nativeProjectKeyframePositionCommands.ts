/** Vec2 position routing for native keyframe commands. The caller supplies
 * document transaction operations so this module cannot commit a partial edit. */
import { applyNativeKeyframeCommand } from "./nativeKeyframeCommands";
import {
  createNativeParameterTrack,
  type NativeInterpolation,
  type NativeKeyframe,
  type NativeParameterTrack,
  type NativeValueType,
} from "./nativeKeyframeTypes";
import type { NativeProjectClip, NativeProjectDocument } from "./nativeProjectDocument";
import { vkfEngine } from "../engine/vkfEngine";
import {
  POSITION_PARAMETER_ID,
  POSITION_X_PARAMETER_ID,
  POSITION_Y_PARAMETER_ID,
  findVec2PositionTrack,
} from "./nativePositionTrack";
import type {
  NativeProjectAtomicKeyframeCommand,
  NativeProjectKeyframeFailure,
  NativeProjectKeyframeFailureCode,
  NativeProjectKeyframeCommandResult,
} from "./nativeProjectKeyframeCommands";

export interface PositionClipLocation {
  readonly trackIndex: number;
  readonly clipIndex: number;
  readonly clip: NativeProjectClip;
}

export interface PositionCommandOperations {
  nativeParameterTrackId: (clipId: string, parameterId: string) => string;
  nativeParameterKeyframeId: (parameterTrackId: string, frame: number) => string;
  reject: (document: NativeProjectDocument, code: NativeProjectKeyframeFailureCode, message: string) => NativeProjectKeyframeCommandResult;
  succeed: (original: NativeProjectDocument, document: NativeProjectDocument) => NativeProjectKeyframeCommandResult;
  replaceParameterTracks: (document: NativeProjectDocument, location: PositionClipLocation, tracks: readonly NativeParameterTrack[]) => NativeProjectDocument;
  mapTrackFailure: (document: NativeProjectDocument, code: string, message: string) => NativeProjectKeyframeCommandResult;
  invalidFrame: (clip: NativeProjectClip, frame: number) => NativeProjectKeyframeFailure | null;
  applyAtomic: (document: NativeProjectDocument, command: NativeProjectAtomicKeyframeCommand) => NativeProjectKeyframeCommandResult;
}

const sameInterpolation = (left: NativeInterpolation, right: NativeInterpolation): boolean =>
  left.type === right.type &&
  (left.type !== "cubic-bezier" ||
    (right.type === "cubic-bezier" &&
      left.controlPoints.x1 === right.controlPoints.x1 &&
      left.controlPoints.y1 === right.controlPoints.y1 &&
      left.controlPoints.x2 === right.controlPoints.x2 &&
      left.controlPoints.y2 === right.controlPoints.y2));

/**
 * Merge a clip's scalar x/y position tracks into one vec2 track, which motion
 * paths and auto-rotate need. Exact only when both components share keyframe
 * frames and easing (the case for position keyframes set as a pair), so any
 * other shape is refused rather than approximated.
 */
const vec2PositionFor = (
  document: NativeProjectDocument,
  location: PositionClipLocation,
  operations: PositionCommandOperations,
): { tracks: readonly NativeParameterTrack[]; track: NativeParameterTrack<"vec2"> } | NativeProjectKeyframeFailure => {
  const tracks = location.clip.parameterTracks;
  const existing = findVec2PositionTrack(tracks);
  if (existing) return { tracks, track: existing };
  const xTrack = tracks.find((track) => track.parameterId === POSITION_X_PARAMETER_ID) as
    | NativeParameterTrack<"number">
    | undefined;
  const yTrack = tracks.find((track) => track.parameterId === POSITION_Y_PARAMETER_ID) as
    | NativeParameterTrack<"number">
    | undefined;
  const misaligned: NativeProjectKeyframeFailure = {
    code: "position-components-misaligned",
    message: "Arc motion needs X and Y position keyframes at the same frames with the same easing",
  };
  if (!xTrack || !yTrack || xTrack.keyframes.length !== yTrack.keyframes.length) return misaligned;
  const trackId = operations.nativeParameterTrackId(location.clip.id, POSITION_PARAMETER_ID);
  const keyframes: NativeKeyframe<{ x: number; y: number }>[] = [];
  for (let index = 0; index < xTrack.keyframes.length; index += 1) {
    const x = xTrack.keyframes[index]!;
    const y = yTrack.keyframes[index]!;
    if (x.frame !== y.frame || !sameInterpolation(x.outgoing, y.outgoing)) return misaligned;
    keyframes.push({
      id: operations.nativeParameterKeyframeId(trackId, x.frame),
      frame: x.frame,
      value: { x: x.value, y: y.value },
      outgoing: x.outgoing,
    });
  }
  const track = createNativeParameterTrack({
    id: trackId,
    parameterId: POSITION_PARAMETER_ID,
    valueType: "vec2",
    frameRate: document.frameRate,
    keyframes,
  });
  return {
    track,
    tracks: [
      ...tracks.filter(
        (candidate) =>
          candidate.parameterId !== POSITION_X_PARAMETER_ID &&
          candidate.parameterId !== POSITION_Y_PARAMETER_ID,
      ),
      track,
    ],
  };
};

const withPositionTrack = (
  tracks: readonly NativeParameterTrack[],
  track: NativeParameterTrack<"vec2">,
): NativeParameterTrack[] => tracks.map((candidate) => (candidate.id === track.id ? track : candidate));

export const applyPositionPathCommand = (
  document: NativeProjectDocument,
  location: PositionClipLocation,
  command: Extract<NativeProjectAtomicKeyframeCommand, { type: "set-motion-path" | "set-auto-rotate" }>,
  operations: PositionCommandOperations,
): NativeProjectKeyframeCommandResult => {
  const resolved = vec2PositionFor(document, location, operations);
  if ("code" in resolved) return operations.reject(document, resolved.code, resolved.message);
  const { track } = resolved;
  let keyframes = track.keyframes;
  let autoRotate = track.autoRotate === true;
  if (command.type === "set-motion-path") {
    const index = keyframes.findIndex((keyframe) => keyframe.frame === command.frame);
    if (index < 0) return operations.reject(document, "missing-keyframe", `Frame ${command.frame} has no position keyframe`);
    if (index === keyframes.length - 1 && command.path) {
      return operations.reject(document, "invalid-value", "The last position keyframe has no following segment");
    }
    keyframes = keyframes.map((keyframe, keyIndex) => {
      if (keyIndex !== index) return keyframe;
      const { outgoingPath: _previous, ...rest } = keyframe;
      return command.path ? { ...rest, outgoingPath: command.path } : rest;
    });
  } else {
    autoRotate = command.autoRotate;
  }
  let next: NativeParameterTrack<"vec2">;
  try {
    next = createNativeParameterTrack({
      id: track.id,
      parameterId: track.parameterId,
      valueType: "vec2",
      frameRate: track.frameRate,
      keyframes,
      autoRotate,
    });
  } catch (error) {
    return operations.reject(
      document,
      "invalid-value",
      error instanceof Error ? error.message : "Invalid motion path",
    );
  }
  return operations.succeed(document, operations.replaceParameterTracks(document, location, withPositionTrack(resolved.tracks, next)));
};

/**
 * x/y edits on a clip whose position is one vec2 track: value edits change one
 * component and keep the other (and the key's easing and path); structural
 * edits apply to the position keyframe as a whole.
 */
export const applyToVec2Position = (
  document: NativeProjectDocument,
  location: PositionClipLocation,
  track: NativeParameterTrack<"vec2">,
  component: "x" | "y",
  command: NativeProjectAtomicKeyframeCommand,
  operations: PositionCommandOperations,
): NativeProjectKeyframeCommandResult => {
  const address = { ...command.address, parameterId: POSITION_PARAMETER_ID };
  const other = component === "x" ? "y" : "x";
  const keyAt = (frame: number) => track.keyframes.find((keyframe) => keyframe.frame === frame);
  if (command.type === "upsert") {
    if (typeof command.value !== "number") {
      return operations.reject(document, "value-type-mismatch", `${command.address.parameterId} takes a number`);
    }
    const invalid = operations.invalidFrame(location.clip, command.frame);
    if (invalid) return operations.reject(document, invalid.code, invalid.message);
    const existing = keyAt(command.frame);
    const current = existing?.value ?? (vkfEngine().evaluate(track, command.frame) as { x: number; y: number });
    const value = { [component]: command.value, [other]: current[other] } as { x: number; y: number };
    const keyframe: NativeKeyframe<{ x: number; y: number }> = {
      id: existing?.id ?? operations.nativeParameterKeyframeId(track.id, command.frame),
      frame: command.frame,
      value,
      outgoing: command.outgoing ?? existing?.outgoing ?? { type: "linear" },
      ...(existing?.outgoingPath ? { outgoingPath: existing.outgoingPath } : {}),
    };
    const result = applyNativeKeyframeCommand(track as NativeParameterTrack<NativeValueType>, {
      type: "upsert",
      keyframe,
    });
    if (!result.ok) return operations.mapTrackFailure(document, result.failure.code, result.failure.message);
    return operations.succeed(
      document,
      operations.replaceParameterTracks(
        document,
        location,
        withPositionTrack(location.clip.parameterTracks, result.track as NativeParameterTrack<"vec2">),
      ),
    );
  }
  if (command.type === "update-value") {
    const existing = keyAt(command.frame);
    if (!existing) return operations.reject(document, "missing-keyframe", `Frame ${command.frame} has no keyframe`);
    if (typeof command.value !== "number") {
      return operations.reject(document, "value-type-mismatch", `${command.address.parameterId} takes a number`);
    }
    return operations.applyAtomic(document, {
      type: "update-value",
      address,
      frame: command.frame,
      value: { ...existing.value, [component]: command.value },
    });
  }
  return operations.applyAtomic(document, { ...command, address } as NativeProjectAtomicKeyframeCommand);
};
