import {
  applyNativeProjectKeyframeCommand,
  type NativeProjectAtomicKeyframeCommand,
  type NativeProjectKeyframeFailure,
  type NativeProjectParameterAddress,
} from "./nativeProjectKeyframeCommands";
import type { NativeParameterValue } from "./nativeKeyframeTypes";
import { evaluateNativeParameterTrack } from "./nativeKeyframeEvaluator";
import {
  parseNativeProjectDocument,
  type NativeProjectClip,
  type NativeProjectDocument,
} from "./nativeProjectDocument";

export interface NativeProjectSetStaticPropertyCommand {
  readonly type: "set-static";
  readonly address: NativeProjectParameterAddress;
  readonly value: NativeParameterValue;
}

export interface NativeProjectOffsetTrackCommand {
  readonly type: "offset-track";
  readonly address: NativeProjectParameterAddress;
  /** Current editor-owned properties are scalar. Vector/color offsets can be
   * added deliberately when their UI contracts exist instead of guessing. */
  readonly delta: number;
}

export interface NativeProjectCollapseTrackCommand {
  readonly type: "collapse-track";
  readonly address: NativeProjectParameterAddress;
  readonly frame: number;
}

export type NativeProjectAtomicPropertyCommand =
  | NativeProjectAtomicKeyframeCommand
  | NativeProjectSetStaticPropertyCommand
  | NativeProjectOffsetTrackCommand
  | NativeProjectCollapseTrackCommand;

export type NativeProjectPropertyCommand =
  | NativeProjectAtomicPropertyCommand
  | {
      readonly type: "batch";
      readonly commands: readonly NativeProjectAtomicPropertyCommand[];
    };

export type NativeProjectPropertyCommandResult =
  | { readonly ok: true; readonly document: NativeProjectDocument }
  | {
      readonly ok: false;
      /** Failed batches expose the identical input reference: no partial state. */
      readonly document: NativeProjectDocument;
      readonly failure: NativeProjectKeyframeFailure;
    };

interface LocatedClip {
  readonly trackIndex: number;
  readonly clipIndex: number;
  readonly clip: NativeProjectClip;
}

const fail = (
  document: NativeProjectDocument,
  code: NativeProjectKeyframeFailure["code"],
  message: string,
): NativeProjectPropertyCommandResult => ({
  ok: false,
  document,
  failure: { code, message },
});

const locateClip = (
  document: NativeProjectDocument,
  address: NativeProjectParameterAddress,
): LocatedClip | NativeProjectKeyframeFailure => {
  if (address.sequenceId !== document.sequence.id) {
    return { code: "missing-sequence", message: `Sequence ${address.sequenceId} does not exist` };
  }
  const trackIndex = document.sequence.tracks.findIndex((track) => track.id === address.trackId);
  if (trackIndex < 0) {
    return { code: "missing-track", message: `Track ${address.trackId} does not exist` };
  }
  const clipIndex = document.sequence.tracks[trackIndex]!.clips.findIndex(
    (clip) => clip.id === address.clipId,
  );
  if (clipIndex < 0) {
    return { code: "missing-clip", message: `Clip ${address.clipId} does not exist` };
  }
  return {
    trackIndex,
    clipIndex,
    clip: document.sequence.tracks[trackIndex]!.clips[clipIndex]!,
  };
};

const replaceClip = (
  document: NativeProjectDocument,
  location: LocatedClip,
  clip: NativeProjectClip,
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
              clips: track.clips.map((candidate, clipIndex) =>
                clipIndex === location.clipIndex ? clip : candidate,
              ),
            },
      ),
    },
  });

const applyStatic = (
  document: NativeProjectDocument,
  command: NativeProjectSetStaticPropertyCommand,
): NativeProjectPropertyCommandResult => {
  const location = locateClip(document, command.address);
  if ("code" in location) return fail(document, location.code, location.message);
  try {
    return {
      ok: true,
      document: replaceClip(document, location, {
        ...location.clip,
        staticParameters: {
          ...(location.clip.staticParameters ?? {}),
          [command.address.parameterId]: command.value,
        },
      }),
    };
  } catch (error) {
    return fail(
      document,
      "invalid-value",
      error instanceof Error ? error.message : "Static parameter value is invalid",
    );
  }
};

const applyOffset = (
  document: NativeProjectDocument,
  command: NativeProjectOffsetTrackCommand,
): NativeProjectPropertyCommandResult => {
  if (!Number.isFinite(command.delta)) {
    return fail(document, "invalid-value", "Track offset must be finite");
  }
  const location = locateClip(document, command.address);
  if ("code" in location) return fail(document, location.code, location.message);
  const parameterIndex = location.clip.parameterTracks.findIndex(
    (track) => track.parameterId === command.address.parameterId,
  );
  if (parameterIndex < 0) {
    return fail(
      document,
      "missing-parameter",
      `Parameter ${command.address.parameterId} does not exist on clip ${command.address.clipId}`,
    );
  }
  const parameterTrack = location.clip.parameterTracks[parameterIndex]!;
  if (parameterTrack.valueType !== "number") {
    return fail(
      document,
      "value-type-mismatch",
      `Parameter ${command.address.parameterId} is not a numeric track`,
    );
  }
  try {
    const nextTrack = {
      ...parameterTrack,
      keyframes: parameterTrack.keyframes.map((keyframe) => ({
        ...keyframe,
        value: (keyframe.value as number) + command.delta,
      })),
    };
    return {
      ok: true,
      document: replaceClip(document, location, {
        ...location.clip,
        parameterTracks: location.clip.parameterTracks.map((track, index) =>
          index === parameterIndex ? nextTrack : track,
        ),
      }),
    };
  } catch (error) {
    return fail(
      document,
      "invalid-value",
      error instanceof Error ? error.message : "Offset produced an invalid parameter value",
    );
  }
};

const applyCollapse = (
  document: NativeProjectDocument,
  command: NativeProjectCollapseTrackCommand,
): NativeProjectPropertyCommandResult => {
  const location = locateClip(document, command.address);
  if ("code" in location) return fail(document, location.code, location.message);
  if (
    !Number.isInteger(command.frame) ||
    command.frame < 0 ||
    command.frame >= location.clip.durationFrames
  ) {
    return fail(
      document,
      "invalid-frame",
      `Frame must be an integer in clip-local range 0 <= frame < ${location.clip.durationFrames}`,
    );
  }
  const parameterIndex = location.clip.parameterTracks.findIndex(
    (track) => track.parameterId === command.address.parameterId,
  );
  if (parameterIndex < 0) {
    return fail(
      document,
      "missing-parameter",
      `Parameter ${command.address.parameterId} does not exist on clip ${command.address.clipId}`,
    );
  }
  const parameterTrack = location.clip.parameterTracks[parameterIndex]!;
  if (
    parameterTrack.frameRate.numerator !== document.frameRate.numerator ||
    parameterTrack.frameRate.denominator !== document.frameRate.denominator
  ) {
    return fail(document, "frame-rate-mismatch", "Parameter frame rate does not match project");
  }
  try {
    const value = evaluateNativeParameterTrack(parameterTrack, command.frame);
    return {
      ok: true,
      document: replaceClip(document, location, {
        ...location.clip,
        staticParameters: {
          ...(location.clip.staticParameters ?? {}),
          [command.address.parameterId]: value,
        },
        parameterTracks: location.clip.parameterTracks.filter(
          (_, index) => index !== parameterIndex,
        ),
      }),
    };
  } catch (error) {
    return fail(
      document,
      "invalid-value",
      error instanceof Error ? error.message : "Could not evaluate parameter track",
    );
  }
};

const applyAtomic = (
  document: NativeProjectDocument,
  command: NativeProjectAtomicPropertyCommand,
): NativeProjectPropertyCommandResult => {
  if (command.type === "set-static") return applyStatic(document, command);
  if (command.type === "offset-track") return applyOffset(document, command);
  if (command.type === "collapse-track") return applyCollapse(document, command);
  const result = applyNativeProjectKeyframeCommand(document, command);
  return result.ok
    ? { ok: true, document: result.document }
    : { ok: false, document, failure: result.failure };
};

/** Apply static and animated property mutations through one rollback boundary. */
export const applyNativeProjectPropertyCommand = (
  document: NativeProjectDocument,
  command: NativeProjectPropertyCommand,
): NativeProjectPropertyCommandResult => {
  if (command.type !== "batch") return applyAtomic(document, command);
  let next = document;
  for (const child of command.commands) {
    const result = applyAtomic(next, child);
    if (!result.ok) return { ...result, document };
    next = result.document;
  }
  return { ok: true, document: next };
};
