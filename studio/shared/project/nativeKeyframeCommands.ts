import {
  NativeKeyframeValidationError,
  createNativeParameterTrack,
  type NativeInterpolation,
  type NativeKeyframe,
  type NativeParameterTrack,
  type NativeParameterValueMap,
  type NativeValueType,
  type RgbaValue,
  type Vec2Value,
} from "./nativeKeyframeTypes";

export type NativeKeyframeCommandFailureCode =
  | "missing-keyframe"
  | "duplicate-keyframe-id"
  | "frame-collision"
  | "invalid-frame"
  | "invalid-group"
  | "invalid-value"
  | "invalid-interpolation"
  | "empty-track"
  | "track-mismatch";

export interface NativeKeyframeCommandFailure {
  readonly code: NativeKeyframeCommandFailureCode;
  readonly message: string;
}

type RestoreTrackCommand<K extends NativeValueType> = {
  readonly type: "restore-track";
  readonly track: NativeParameterTrack<K>;
};

export type NativeKeyframeCommand<K extends NativeValueType> =
  | {
      readonly type: "insert";
      readonly keyframe: NativeKeyframe<NativeParameterValueMap[K]>;
    }
  | {
      /** Replaces the key at this exact frame, preserving its ID, or inserts if vacant. */
      readonly type: "upsert";
      readonly keyframe: NativeKeyframe<NativeParameterValueMap[K]>;
    }
  | {
      readonly type: "update-value";
      readonly keyframeId: string;
      readonly value: NativeParameterValueMap[K];
    }
  | { readonly type: "move"; readonly keyframeId: string; readonly toFrame: number }
  | {
      readonly type: "move-group";
      readonly keyframeIds: readonly string[];
      readonly deltaFrames: number;
    }
  | { readonly type: "delete"; readonly keyframeId: string }
  | { readonly type: "delete-group"; readonly keyframeIds: readonly string[] }
  | {
      readonly type: "set-outgoing";
      readonly keyframeId: string;
      readonly outgoing: NativeInterpolation;
    }
  | RestoreTrackCommand<K>;

export interface NativeKeyframeCommandSuccess<K extends NativeValueType> {
  readonly ok: true;
  readonly track: NativeParameterTrack<K>;
  readonly inverse: NativeKeyframeCommand<K>;
}

export interface NativeKeyframeCommandRejected<K extends NativeValueType> {
  readonly ok: false;
  /** The identical input reference, proving no partial mutation escaped. */
  readonly track: NativeParameterTrack<K>;
  readonly failure: NativeKeyframeCommandFailure;
}

export type NativeKeyframeCommandResult<K extends NativeValueType> =
  | NativeKeyframeCommandSuccess<K>
  | NativeKeyframeCommandRejected<K>;

const cloneValue = <K extends NativeValueType>(
  valueType: K,
  value: NativeParameterValueMap[K],
): NativeParameterValueMap[K] => {
  if (valueType === "number") return value;
  return { ...(value as Vec2Value | RgbaValue) } as NativeParameterValueMap[K];
};

const cloneInterpolation = (outgoing: NativeInterpolation): NativeInterpolation => {
  if (outgoing.type !== "cubic-bezier") return { type: outgoing.type };
  return { type: outgoing.type, controlPoints: { ...outgoing.controlPoints } };
};

const cloneKeyframe = <K extends NativeValueType>(
  valueType: K,
  keyframe: NativeKeyframe<NativeParameterValueMap[K]>,
): NativeKeyframe<NativeParameterValueMap[K]> => ({
  id: keyframe.id,
  frame: keyframe.frame,
  value: cloneValue(valueType, keyframe.value),
  outgoing: cloneInterpolation(keyframe.outgoing),
});

const cloneTrack = <K extends NativeValueType>(
  track: NativeParameterTrack<K>,
): NativeParameterTrack<K> =>
  createNativeParameterTrack({
    id: track.id,
    parameterId: track.parameterId,
    valueType: track.valueType,
    frameRate: { ...track.frameRate },
    keyframes: track.keyframes.map((keyframe) => cloneKeyframe(track.valueType, keyframe)),
  });

const reject = <K extends NativeValueType>(
  track: NativeParameterTrack<K>,
  code: NativeKeyframeCommandFailureCode,
  message: string,
): NativeKeyframeCommandRejected<K> => ({ ok: false, track, failure: { code, message } });

const succeed = <K extends NativeValueType>(
  original: NativeParameterTrack<K>,
  track: NativeParameterTrack<K>,
): NativeKeyframeCommandSuccess<K> => ({
  ok: true,
  track,
  inverse: { type: "restore-track", track: cloneTrack(original) },
});

const mapValidationFailure = (error: NativeKeyframeValidationError): NativeKeyframeCommandFailure => {
  switch (error.code) {
    case "duplicate-keyframe-id":
      return { code: "duplicate-keyframe-id", message: error.message };
    case "duplicate-keyframe-frame":
      return { code: "frame-collision", message: error.message };
    case "invalid-keyframe-frame":
      return { code: "invalid-frame", message: error.message };
    case "invalid-interpolation":
      return { code: "invalid-interpolation", message: error.message };
    case "empty-track":
      return { code: "empty-track", message: error.message };
    default:
      return { code: "invalid-value", message: error.message };
  }
};

const rebuild = <K extends NativeValueType>(
  original: NativeParameterTrack<K>,
  keyframes: readonly NativeKeyframe<NativeParameterValueMap[K]>[],
): NativeKeyframeCommandResult<K> => {
  try {
    const track = createNativeParameterTrack({
      id: original.id,
      parameterId: original.parameterId,
      valueType: original.valueType,
      frameRate: original.frameRate,
      keyframes,
    });
    return succeed(original, track);
  } catch (error) {
    if (error instanceof NativeKeyframeValidationError) {
      const failure = mapValidationFailure(error);
      return reject(original, failure.code, failure.message);
    }
    throw error;
  }
};

const validateFrame = <K extends NativeValueType>(
  track: NativeParameterTrack<K>,
  frame: number,
): NativeKeyframeCommandRejected<K> | null => {
  if (!Number.isInteger(frame) || frame < 0) {
    return reject(track, "invalid-frame", "Keyframe time must be a non-negative integer project frame");
  }
  return null;
};

const validateGroup = <K extends NativeValueType>(
  track: NativeParameterTrack<K>,
  keyframeIds: readonly string[],
): NativeKeyframeCommandRejected<K> | null => {
  if (keyframeIds.length === 0) {
    return reject(track, "invalid-group", "A keyframe group must contain at least one ID");
  }
  if (new Set(keyframeIds).size !== keyframeIds.length) {
    return reject(track, "invalid-group", "A keyframe group must not contain duplicate IDs");
  }
  const availableIds = new Set(track.keyframes.map((keyframe) => keyframe.id));
  const missingId = keyframeIds.find((id) => !availableIds.has(id));
  if (missingId) {
    return reject(track, "missing-keyframe", `Keyframe ${missingId} does not exist`);
  }
  return null;
};

export const applyNativeKeyframeCommand = <K extends NativeValueType>(
  track: NativeParameterTrack<K>,
  command: NativeKeyframeCommand<K>,
): NativeKeyframeCommandResult<K> => {
  if (command.type === "restore-track") {
    if (
      command.track.id !== track.id ||
      command.track.parameterId !== track.parameterId ||
      command.track.valueType !== track.valueType ||
      command.track.frameRate.numerator !== track.frameRate.numerator ||
      command.track.frameRate.denominator !== track.frameRate.denominator
    ) {
      return reject(track, "track-mismatch", "An inverse can only restore the track it was created for");
    }
    return succeed(track, cloneTrack(command.track));
  }

  if (command.type === "insert" || command.type === "upsert") {
    const invalidFrame = validateFrame(track, command.keyframe.frame);
    if (invalidFrame) return invalidFrame;

    if (command.type === "insert") {
      if (track.keyframes.some((keyframe) => keyframe.id === command.keyframe.id)) {
        return reject(
          track,
          "duplicate-keyframe-id",
          `Keyframe ID ${command.keyframe.id} already exists`,
        );
      }
      if (track.keyframes.some((keyframe) => keyframe.frame === command.keyframe.frame)) {
        return reject(
          track,
          "frame-collision",
          `Project frame ${command.keyframe.frame} already contains a keyframe`,
        );
      }
      return rebuild(track, [...track.keyframes, cloneKeyframe(track.valueType, command.keyframe)]);
    }

    const occupied = track.keyframes.find((keyframe) => keyframe.frame === command.keyframe.frame);
    if (!occupied) {
      if (track.keyframes.some((keyframe) => keyframe.id === command.keyframe.id)) {
        return reject(
          track,
          "duplicate-keyframe-id",
          `Keyframe ID ${command.keyframe.id} already exists`,
        );
      }
      return rebuild(track, [...track.keyframes, cloneKeyframe(track.valueType, command.keyframe)]);
    }
    return rebuild(
      track,
      track.keyframes.map((keyframe) =>
        keyframe.id === occupied.id
          ? { ...cloneKeyframe(track.valueType, command.keyframe), id: occupied.id }
          : keyframe,
      ),
    );
  }

  if (command.type === "update-value") {
    if (!track.keyframes.some((keyframe) => keyframe.id === command.keyframeId)) {
      return reject(track, "missing-keyframe", `Keyframe ${command.keyframeId} does not exist`);
    }
    return rebuild(
      track,
      track.keyframes.map((keyframe) =>
        keyframe.id === command.keyframeId
          ? { ...keyframe, value: cloneValue(track.valueType, command.value) }
          : keyframe,
      ),
    );
  }

  if (command.type === "move") {
    const invalidFrame = validateFrame(track, command.toFrame);
    if (invalidFrame) return invalidFrame;
    if (!track.keyframes.some((keyframe) => keyframe.id === command.keyframeId)) {
      return reject(track, "missing-keyframe", `Keyframe ${command.keyframeId} does not exist`);
    }
    if (
      track.keyframes.some(
        (keyframe) => keyframe.id !== command.keyframeId && keyframe.frame === command.toFrame,
      )
    ) {
      return reject(track, "frame-collision", `Project frame ${command.toFrame} is occupied`);
    }
    return rebuild(
      track,
      track.keyframes.map((keyframe) =>
        keyframe.id === command.keyframeId ? { ...keyframe, frame: command.toFrame } : keyframe,
      ),
    );
  }

  if (command.type === "move-group") {
    const invalidGroup = validateGroup(track, command.keyframeIds);
    if (invalidGroup) return invalidGroup;
    if (!Number.isInteger(command.deltaFrames)) {
      return reject(track, "invalid-frame", "Group movement must use an integer frame delta");
    }

    const movingIds = new Set(command.keyframeIds);
    const stationaryFrames = new Set(
      track.keyframes
        .filter((keyframe) => !movingIds.has(keyframe.id))
        .map((keyframe) => keyframe.frame),
    );
    for (const keyframe of track.keyframes) {
      if (!movingIds.has(keyframe.id)) continue;
      const destination = keyframe.frame + command.deltaFrames;
      const invalidFrame = validateFrame(track, destination);
      if (invalidFrame) return invalidFrame;
      if (stationaryFrames.has(destination)) {
        return reject(track, "frame-collision", `Project frame ${destination} is occupied`);
      }
    }

    return rebuild(
      track,
      track.keyframes.map((keyframe) =>
        movingIds.has(keyframe.id)
          ? { ...keyframe, frame: keyframe.frame + command.deltaFrames }
          : keyframe,
      ),
    );
  }

  if (command.type === "delete" || command.type === "delete-group") {
    const keyframeIds = command.type === "delete" ? [command.keyframeId] : command.keyframeIds;
    const invalidGroup = validateGroup(track, keyframeIds);
    if (invalidGroup) return invalidGroup;
    const deletedIds = new Set(keyframeIds);
    return rebuild(
      track,
      track.keyframes.filter((keyframe) => !deletedIds.has(keyframe.id)),
    );
  }

  if (!track.keyframes.some((keyframe) => keyframe.id === command.keyframeId)) {
    return reject(track, "missing-keyframe", `Keyframe ${command.keyframeId} does not exist`);
  }
  return rebuild(
    track,
    track.keyframes.map((keyframe) =>
      keyframe.id === command.keyframeId
        ? { ...keyframe, outgoing: cloneInterpolation(command.outgoing) }
        : keyframe,
    ),
  );
};
