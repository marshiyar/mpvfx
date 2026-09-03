import {
  applyNativeKeyframeCommand,
  type NativeKeyframeCommand,
} from "./nativeKeyframeCommands";
import {
  NativeKeyframeValidationError,
  createNativeParameterTrack,
  type NativeInterpolation,
  type NativeKeyframe,
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

const applyAtomic = (
  document: NativeProjectDocument,
  command: NativeProjectAtomicKeyframeCommand,
): NativeProjectKeyframeCommandResult => {
  const location = locateClip(document, command.address);
  if (isFailure(location)) return reject(document, location.code, location.message);

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

  let next = document;
  for (const child of command.commands) {
    const result = applyAtomic(next, child);
    if (!result.ok) return reject(document, result.failure.code, result.failure.message);
    next = result.document;
  }
  return succeed(document, next);
};
