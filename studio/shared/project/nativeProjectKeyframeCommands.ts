import {
  applyNativeKeyframeCommand,
  type NativeKeyframeCommand,
} from "./nativeKeyframeCommands";
import {
  NativeKeyframeValidationError,
  createNativeParameterTrack,
  type NativeInterpolation,
  type NativeKeyframe,
  type NativeMotionPath,
  type NativeParameterTrack,
  type NativeParameterValue,
  type NativeParameterValueMap,
  type NativeValueType,
} from "./nativeKeyframeTypes";
import {
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectClip,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { vkfEngine } from "../engine/vkfEngine";
import {
  POSITION_PARAMETER_ID,
  POSITION_X_PARAMETER_ID,
  POSITION_Y_PARAMETER_ID,
  findVec2PositionTrack,
  positionComponentOf,
} from "./nativePositionTrack";

const valueMatchesType = (valueType: NativeValueType, value: unknown): boolean => {
  if (valueType === "number") return typeof value === "number";
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (valueType === "vec2") {
    return typeof record.x === "number" && typeof record.y === "number";
  }
  return (
    typeof record.red === "number" &&
    typeof record.green === "number" &&
    typeof record.blue === "number" &&
    typeof record.alpha === "number"
  );
};

export interface NativeProjectParameterAddress {
  readonly sequenceId: string;
  readonly trackId: string;
  readonly clipId: string;
  readonly parameterId: string;
}

type UpsertCommand = {
  [K in NativeValueType]: {
    readonly type: "upsert";
    readonly address: NativeProjectParameterAddress;
    readonly valueType: K;
    readonly frame: number;
    readonly value: NativeParameterValueMap[K];
    readonly baselineValue: NativeParameterValueMap[K];
    readonly outgoing?: NativeInterpolation;
  };
}[NativeValueType];

export type NativeProjectAtomicKeyframeCommand =
  | UpsertCommand
  | {
      readonly type: "update-value";
      readonly address: NativeProjectParameterAddress;
      readonly frame: number;
      readonly value: NativeParameterValue;
    }
  | {
      readonly type: "delete";
      readonly address: NativeProjectParameterAddress;
      readonly frame: number;
    }
  | {
      readonly type: "move";
      readonly address: NativeProjectParameterAddress;
      readonly fromFrame: number;
      readonly toFrame: number;
    }
  | {
      readonly type: "move-many";
      readonly address: NativeProjectParameterAddress;
      readonly frames: readonly number[];
      readonly deltaFrames: number;
    }
  | {
      readonly type: "delete-many";
      readonly address: NativeProjectParameterAddress;
      readonly frames: readonly number[];
    }
  | {
      readonly type: "set-outgoing";
      readonly address: NativeProjectParameterAddress;
      readonly frame: number;
      readonly outgoing: NativeInterpolation;
    }
  | {
      /** Shape of the position path from the keyframe at `frame` to the next; null = straight. */
      readonly type: "set-motion-path";
      readonly address: NativeProjectParameterAddress;
      readonly frame: number;
      readonly path: NativeMotionPath | null;
    }
  | {
      /** Turn the layer to face its direction of motion along the position path. */
      readonly type: "set-auto-rotate";
      readonly address: NativeProjectParameterAddress;
      readonly autoRotate: boolean;
    };

type RestoreDocumentCommand = {
  readonly type: "restore-document";
  readonly document: NativeProjectDocument;
};

export type NativeProjectKeyframeCommand =
  | NativeProjectAtomicKeyframeCommand
  | {
      readonly type: "batch";
      readonly commands: readonly NativeProjectAtomicKeyframeCommand[];
    }
  | RestoreDocumentCommand;

export type NativeProjectKeyframeFailureCode =
  | "missing-sequence"
  | "missing-track"
  | "missing-clip"
  | "missing-parameter"
  | "missing-keyframe"
  | "invalid-frame"
  | "invalid-group"
  | "frame-collision"
  | "value-type-mismatch"
  | "frame-rate-mismatch"
  | "invalid-value"
  | "invalid-interpolation"
  | "position-components-misaligned"
  | "document-mismatch";

export interface NativeProjectKeyframeFailure {
  readonly code: NativeProjectKeyframeFailureCode;
  readonly message: string;
}

export type NativeProjectKeyframeCommandResult =
  | {
      readonly ok: true;
      readonly document: NativeProjectDocument;
      readonly inverse: NativeProjectKeyframeCommand;
    }
  | {
      readonly ok: false;
      /** The identical input reference; failed edits never expose a partial document. */
      readonly document: NativeProjectDocument;
      readonly failure: NativeProjectKeyframeFailure;
    };

const stableIdPart = (value: string): string => `${value.length}:${value}`;

export const nativeParameterTrackId = (clipId: string, parameterId: string): string =>
  `native-parameter:${stableIdPart(clipId)}|${stableIdPart(parameterId)}`;

export const nativeParameterKeyframeId = (parameterTrackId: string, frame: number): string =>
  `native-keyframe:${stableIdPart(parameterTrackId)}|frame:${frame}`;

const cloneDocument = (document: NativeProjectDocument): NativeProjectDocument =>
  parseNativeProjectDocument(JSON.parse(serializeNativeProjectDocument(document)));

const reject = (
  document: NativeProjectDocument,
  code: NativeProjectKeyframeFailureCode,
  message: string,
): NativeProjectKeyframeCommandResult => ({ ok: false, document, failure: { code, message } });

const succeed = (
  original: NativeProjectDocument,
  document: NativeProjectDocument,
): NativeProjectKeyframeCommandResult => ({
  ok: true,
  document,
  inverse: { type: "restore-document", document: cloneDocument(original) },
});

interface LocatedClip {
  readonly trackIndex: number;
  readonly clipIndex: number;
  readonly clip: NativeProjectClip;
}

const locateClip = (
  document: NativeProjectDocument,
  address: NativeProjectParameterAddress,
): LocatedClip | NativeProjectKeyframeFailure => {
  if (document.sequence.id !== address.sequenceId) {
    return { code: "missing-sequence", message: `Sequence ${address.sequenceId} does not exist` };
  }
  const trackIndex = document.sequence.tracks.findIndex((track) => track.id === address.trackId);
  if (trackIndex < 0) {
    return { code: "missing-track", message: `Track ${address.trackId} does not exist` };
  }
  const clipIndex = document.sequence.tracks[trackIndex].clips.findIndex(
    (clip) => clip.id === address.clipId,
  );
  if (clipIndex < 0) {
    return { code: "missing-clip", message: `Clip ${address.clipId} does not exist` };
  }
  return {
    trackIndex,
    clipIndex,
    clip: document.sequence.tracks[trackIndex].clips[clipIndex],
  };
};

const isFailure = (value: LocatedClip | NativeProjectKeyframeFailure): value is NativeProjectKeyframeFailure =>
  "code" in value;

const invalidFrame = (clip: NativeProjectClip, frame: number): NativeProjectKeyframeFailure | null => {
  if (!Number.isInteger(frame) || frame < 0 || frame >= clip.durationFrames) {
    return {
      code: "invalid-frame",
      message: `Frame must be an integer in clip-local range 0 <= frame < ${clip.durationFrames}`,
    };
  }
  return null;
};

const replaceParameterTracks = (
  document: NativeProjectDocument,
  location: LocatedClip,
  parameterTracks: readonly NativeParameterTrack[],
): NativeProjectDocument =>
  parseNativeProjectDocument({
    ...document,
    sequence: {
      ...document.sequence,
      tracks: document.sequence.tracks.map((track, trackIndex) =>
        trackIndex !== location.trackIndex
          ? track
          : {
              ...track,
              clips: track.clips.map((clip, clipIndex) =>
                clipIndex !== location.clipIndex ? clip : { ...clip, parameterTracks },
              ),
            },
      ),
    },
  });

const mapTrackFailure = (
  document: NativeProjectDocument,
  code: string,
  message: string,
): NativeProjectKeyframeCommandResult => {
  const mapped: NativeProjectKeyframeFailureCode =
    code === "missing-keyframe"
      ? "missing-keyframe"
      : code === "invalid-frame"
        ? "invalid-frame"
        : code === "frame-collision"
          ? "frame-collision"
          : code === "invalid-group"
            ? "invalid-group"
          : code === "invalid-interpolation"
            ? "invalid-interpolation"
            : "invalid-value";
  return reject(document, mapped, message);
};

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
  location: LocatedClip,
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
  const trackId = nativeParameterTrackId(location.clip.id, POSITION_PARAMETER_ID);
  const keyframes: NativeKeyframe<{ x: number; y: number }>[] = [];
  for (let index = 0; index < xTrack.keyframes.length; index += 1) {
    const x = xTrack.keyframes[index]!;
    const y = yTrack.keyframes[index]!;
    if (x.frame !== y.frame || !sameInterpolation(x.outgoing, y.outgoing)) return misaligned;
    keyframes.push({
      id: nativeParameterKeyframeId(trackId, x.frame),
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

const applyPositionPathCommand = (
  document: NativeProjectDocument,
  location: LocatedClip,
  command: Extract<NativeProjectAtomicKeyframeCommand, { type: "set-motion-path" | "set-auto-rotate" }>,
): NativeProjectKeyframeCommandResult => {
  const resolved = vec2PositionFor(document, location);
  if ("code" in resolved) return reject(document, resolved.code, resolved.message);
  const { track } = resolved;
  let keyframes = track.keyframes;
  let autoRotate = track.autoRotate === true;
  if (command.type === "set-motion-path") {
    const index = keyframes.findIndex((keyframe) => keyframe.frame === command.frame);
    if (index < 0) return reject(document, "missing-keyframe", `Frame ${command.frame} has no position keyframe`);
    if (index === keyframes.length - 1 && command.path) {
      return reject(document, "invalid-value", "The last position keyframe has no following segment");
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
    return reject(
      document,
      "invalid-value",
      error instanceof Error ? error.message : "Invalid motion path",
    );
  }
  return succeed(document, replaceParameterTracks(document, location, withPositionTrack(resolved.tracks, next)));
};

/**
 * x/y edits on a clip whose position is one vec2 track: value edits change one
 * component and keep the other (and the key's easing and path); structural
 * edits apply to the position keyframe as a whole.
 */
const applyToVec2Position = (
  document: NativeProjectDocument,
  location: LocatedClip,
  track: NativeParameterTrack<"vec2">,
  component: "x" | "y",
  command: NativeProjectAtomicKeyframeCommand,
): NativeProjectKeyframeCommandResult => {
  const address = { ...command.address, parameterId: POSITION_PARAMETER_ID };
  const other = component === "x" ? "y" : "x";
  const keyAt = (frame: number) => track.keyframes.find((keyframe) => keyframe.frame === frame);
  if (command.type === "upsert") {
    if (typeof command.value !== "number") {
      return reject(document, "value-type-mismatch", `${command.address.parameterId} takes a number`);
    }
    const invalid = invalidFrame(location.clip, command.frame);
    if (invalid) return reject(document, invalid.code, invalid.message);
    const existing = keyAt(command.frame);
    const current = existing?.value ?? (vkfEngine().evaluate(track, command.frame) as { x: number; y: number });
    const value = { [component]: command.value, [other]: current[other] } as { x: number; y: number };
    const keyframe: NativeKeyframe<{ x: number; y: number }> = {
      id: existing?.id ?? nativeParameterKeyframeId(track.id, command.frame),
      frame: command.frame,
      value,
      outgoing: command.outgoing ?? existing?.outgoing ?? { type: "linear" },
      ...(existing?.outgoingPath ? { outgoingPath: existing.outgoingPath } : {}),
    };
    const result = applyNativeKeyframeCommand(track as NativeParameterTrack<NativeValueType>, {
      type: "upsert",
      keyframe,
    });
    if (!result.ok) return mapTrackFailure(document, result.failure.code, result.failure.message);
    return succeed(
      document,
      replaceParameterTracks(
        document,
        location,
        withPositionTrack(location.clip.parameterTracks, result.track as NativeParameterTrack<"vec2">),
      ),
    );
  }
  if (command.type === "update-value") {
    const existing = keyAt(command.frame);
    if (!existing) return reject(document, "missing-keyframe", `Frame ${command.frame} has no keyframe`);
    if (typeof command.value !== "number") {
      return reject(document, "value-type-mismatch", `${command.address.parameterId} takes a number`);
    }
    return applyAtomic(document, {
      type: "update-value",
      address,
      frame: command.frame,
      value: { ...existing.value, [component]: command.value },
    });
  }
  return applyAtomic(document, { ...command, address } as NativeProjectAtomicKeyframeCommand);
};

/** The vec2 position a component command is routed to, if the clip uses one. */
export const routedPosition = (
  clip: NativeProjectClip,
  parameterId: string,
): { track: NativeParameterTrack<"vec2">; component: "x" | "y" } | null => {
  const component = positionComponentOf(parameterId);
  if (!component) return null;
  if (clip.parameterTracks.some((track) => track.parameterId === parameterId)) return null;
  const track = findVec2PositionTrack(clip.parameterTracks);
  return track ? { track, component } : null;
};

/**
 * Editors send position edits as an x/y pair. On a vec2 position the two
 * structural halves (move, delete, easing, collapse) are one edit: batches
 * apply a signature once. Value edits are per component and never merged.
 * `document` is the batch's starting document.
 */
export const positionPairSignature = (
  document: NativeProjectDocument,
  command: { readonly type: string; readonly address: NativeProjectParameterAddress },
): string | null => {
  if (command.type === "upsert" || command.type === "update-value" || command.type === "offset-track" || command.type === "set-static") return null;
  const location = locateClip(document, command.address);
  if (isFailure(location) || !routedPosition(location.clip, command.address.parameterId)) return null;
  const { address, ...rest } = command as typeof command & Record<string, unknown>;
  return JSON.stringify([address.sequenceId, address.trackId, address.clipId, rest]);
};

const applyAtomic = (
  document: NativeProjectDocument,
  command: NativeProjectAtomicKeyframeCommand,
): NativeProjectKeyframeCommandResult => {
  const location = locateClip(document, command.address);
  if (isFailure(location)) return reject(document, location.code, location.message);
  if (command.type === "set-motion-path" || command.type === "set-auto-rotate") {
    return applyPositionPathCommand(document, location, command);
  }
  const routed = routedPosition(location.clip, command.address.parameterId);
  if (routed) return applyToVec2Position(document, location, routed.track, routed.component, command);

  const frames =
    command.type === "move"
      ? [command.fromFrame, command.toFrame]
      : command.type === "move-many"
        ? [
            ...command.frames,
            ...command.frames.map((frame) => frame + command.deltaFrames),
          ]
        : command.type === "delete-many"
          ? command.frames
          : [command.frame];
  if (
    (command.type === "move-many" || command.type === "delete-many") &&
    (command.frames.length === 0 || new Set(command.frames).size !== command.frames.length)
  ) {
    return reject(document, "invalid-group", "A keyframe group must contain unique frame identities");
  }
  if (command.type === "move-many" && !Number.isInteger(command.deltaFrames)) {
    return reject(document, "invalid-frame", "Multi-keyframe movement requires an integer frame delta");
  }
  for (const frame of frames) {
    const failure = invalidFrame(location.clip, frame);
    if (failure) return reject(document, failure.code, failure.message);
  }

  const parameterIndex = location.clip.parameterTracks.findIndex(
    (track) => track.parameterId === command.address.parameterId,
  );
  const parameterTrack = location.clip.parameterTracks[parameterIndex];

  if (
    command.type === "upsert" &&
    (!valueMatchesType(command.valueType, command.value) ||
      !valueMatchesType(command.valueType, command.baselineValue))
  ) {
    return reject(
      document,
      "value-type-mismatch",
      `Parameter ${command.address.parameterId} values do not match ${command.valueType}`,
    );
  }

  if (command.type === "upsert" && !parameterTrack) {
    const trackId = nativeParameterTrackId(command.address.clipId, command.address.parameterId);
    const outgoing = command.outgoing ?? { type: "linear" as const };
    const keyframes: NativeKeyframe<NativeParameterValueMap[typeof command.valueType]>[] = [
      {
        id: nativeParameterKeyframeId(trackId, command.frame),
        frame: command.frame,
        value: command.value,
        outgoing,
      },
    ];
    try {
      const created = createNativeParameterTrack({
        id: trackId,
        parameterId: command.address.parameterId,
        valueType: command.valueType,
        frameRate: document.frameRate,
        keyframes,
      });
      const next = replaceParameterTracks(document, location, [
        ...location.clip.parameterTracks,
        created,
      ]);
      return succeed(document, next);
    } catch (error) {
      return reject(
        document,
        error instanceof NativeKeyframeValidationError && error.code === "invalid-interpolation"
          ? "invalid-interpolation"
          : "invalid-value",
        error instanceof Error ? error.message : "Invalid parameter value",
      );
    }
  }

  if (!parameterTrack) {
    return reject(
      document,
      "missing-parameter",
      `Parameter ${command.address.parameterId} does not exist on clip ${command.address.clipId}`,
    );
  }
  if (
    parameterTrack.frameRate.numerator !== document.frameRate.numerator ||
    parameterTrack.frameRate.denominator !== document.frameRate.denominator
  ) {
    return reject(
      document,
      "frame-rate-mismatch",
      `Parameter ${command.address.parameterId} frame rate does not match the project`,
    );
  }
  if (command.type === "upsert" && parameterTrack.valueType !== command.valueType) {
    return reject(
      document,
      "value-type-mismatch",
      `Parameter ${command.address.parameterId} uses ${parameterTrack.valueType}, not ${command.valueType}`,
    );
  }
  if (
    command.type === "update-value" &&
    !valueMatchesType(parameterTrack.valueType, command.value)
  ) {
    return reject(
      document,
      "value-type-mismatch",
      `Parameter ${command.address.parameterId} value does not match ${parameterTrack.valueType}`,
    );
  }

  const keyframeAt = (frame: number) =>
    parameterTrack.keyframes.find((keyframe) => keyframe.frame === frame);
  let trackCommand: NativeKeyframeCommand<NativeValueType>;
  if (command.type === "upsert") {
    const existing = keyframeAt(command.frame);
    trackCommand = {
      type: "upsert",
      keyframe: {
        id: existing?.id ?? nativeParameterKeyframeId(parameterTrack.id, command.frame),
        frame: command.frame,
        value: command.value,
        outgoing: command.outgoing ?? existing?.outgoing ?? { type: "linear" },
      },
    };
  } else if (command.type === "update-value") {
    const existing = keyframeAt(command.frame);
    if (!existing) {
      return reject(document, "missing-keyframe", `Frame ${command.frame} has no keyframe`);
    }
    trackCommand = { type: "update-value", keyframeId: existing.id, value: command.value };
  } else if (command.type === "delete") {
    const existing = keyframeAt(command.frame);
    if (!existing) {
      return reject(document, "missing-keyframe", `Frame ${command.frame} has no keyframe`);
    }
    if (parameterTrack.keyframes.length === 1) {
      const nextTracks = location.clip.parameterTracks.filter((_, index) => index !== parameterIndex);
      return succeed(document, replaceParameterTracks(document, location, nextTracks));
    }
    trackCommand = { type: "delete", keyframeId: existing.id };
  } else if (command.type === "move") {
    const existing = keyframeAt(command.fromFrame);
    if (!existing) {
      return reject(document, "missing-keyframe", `Frame ${command.fromFrame} has no keyframe`);
    }
    trackCommand = { type: "move", keyframeId: existing.id, toFrame: command.toFrame };
  } else if (command.type === "move-many") {
    const keyframes = command.frames.map((frame) => keyframeAt(frame));
    const missingIndex = keyframes.findIndex((keyframe) => !keyframe);
    if (missingIndex >= 0) {
      return reject(
        document,
        "missing-keyframe",
        `Frame ${command.frames[missingIndex]} has no keyframe`,
      );
    }
    trackCommand = {
      type: "move-group",
      keyframeIds: keyframes.map((keyframe) => keyframe!.id),
      deltaFrames: command.deltaFrames,
    };
  } else if (command.type === "delete-many") {
    const keyframes = command.frames.map((frame) => keyframeAt(frame));
    const missingIndex = keyframes.findIndex((keyframe) => !keyframe);
    if (missingIndex >= 0) {
      return reject(
        document,
        "missing-keyframe",
        `Frame ${command.frames[missingIndex]} has no keyframe`,
      );
    }
    if (keyframes.length === parameterTrack.keyframes.length) {
      const nextTracks = location.clip.parameterTracks.filter((_, index) => index !== parameterIndex);
      return succeed(document, replaceParameterTracks(document, location, nextTracks));
    }
    trackCommand = {
      type: "delete-group",
      keyframeIds: keyframes.map((keyframe) => keyframe!.id),
    };
  } else {
    const existing = keyframeAt(command.frame);
    if (!existing) {
      return reject(document, "missing-keyframe", `Frame ${command.frame} has no keyframe`);
    }
    trackCommand = {
      type: "set-outgoing",
      keyframeId: existing.id,
      outgoing: command.outgoing,
    };
  }

  const trackResult = applyNativeKeyframeCommand(
    parameterTrack as NativeParameterTrack<NativeValueType>,
    trackCommand,
  );
  if (!trackResult.ok) {
    return mapTrackFailure(document, trackResult.failure.code, trackResult.failure.message);
  }
  const nextTracks = location.clip.parameterTracks.map((track, index) =>
    index === parameterIndex ? trackResult.track : track,
  );
  return succeed(document, replaceParameterTracks(document, location, nextTracks));
};

export const applyNativeProjectKeyframeCommand = (
  document: NativeProjectDocument,
  command: NativeProjectKeyframeCommand,
): NativeProjectKeyframeCommandResult => {
  if (command.type === "restore-document") {
    if (command.document.id !== document.id) {
      return reject(document, "document-mismatch", "An inverse can only restore its source project");
    }
    return succeed(document, cloneDocument(command.document));
  }

  if (command.type !== "batch") return applyAtomic(document, command);

  const applied = new Set<string>();
  let next = document;
  for (const child of command.commands) {
    const signature = positionPairSignature(document, child);
    if (signature !== null) {
      if (applied.has(signature)) continue;
      applied.add(signature);
    }
    const result = applyAtomic(next, child);
    if (!result.ok) return reject(document, result.failure.code, result.failure.message);
    next = result.document;
  }
  return succeed(document, next);
};
