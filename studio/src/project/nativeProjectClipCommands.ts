import {
  DEFAULT_NATIVE_PLAYBACK_RATE,
  NativeProjectDocumentValidationError,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeClipDomBinding,
  type NativeProjectClip,
  type NativeProjectDocument,
  type NativeProjectTrack,
} from "./nativeProjectDocument";
import { evaluateNativeParameterTrack } from "./nativeKeyframeEvaluator";
import {
  createNativeParameterTrack,
  type NativeParameterTrack,
  type NativeValueType,
} from "./nativeKeyframeTypes";

/** Exact durable address of a clip in the active native sequence. */
export interface NativeProjectClipAddress {
  readonly sequenceId: string;
  readonly trackId: string;
  readonly clipId: string;
}

export interface NativeProjectClipDestination {
  readonly trackId: string;
  readonly startFrame: number;
}

export interface NativeProjectClipMove {
  readonly address: NativeProjectClipAddress;
  readonly destination: NativeProjectClipDestination;
}

export type NativeProjectClipCommand =
  | { readonly type: "move"; readonly address: NativeProjectClipAddress; readonly destination: NativeProjectClipDestination }
  | { readonly type: "move-many"; readonly moves: readonly NativeProjectClipMove[] }
  | { readonly type: "trim-in"; readonly address: NativeProjectClipAddress; readonly startFrame: number }
  | { readonly type: "trim-out"; readonly address: NativeProjectClipAddress; readonly endFrameExclusive: number }
  | {
      readonly type: "split";
      readonly address: NativeProjectClipAddress;
      readonly splitFrame: number;
      /** Required when the source clip has a legacy DOM binding. */
      readonly rightBinding?: NativeClipDomBinding;
    }
  | { readonly type: "delete"; readonly address: NativeProjectClipAddress }
  | { readonly type: "delete-many"; readonly addresses: readonly NativeProjectClipAddress[] }
  | { readonly type: "restore-document"; readonly document: NativeProjectDocument };

export type NativeProjectClipFailureCode =
  | "missing-sequence"
  | "missing-source-track"
  | "missing-destination-track"
  | "missing-clip"
  | "incompatible-destination"
  | "invalid-start-frame"
  | "duplicate-target"
  | "destination-collision"
  | "invalid-trim"
  | "invalid-split"
  | "non-integral-source-boundary"
  | "missing-split-binding"
  | "invalid-split-binding"
  | "duplicate-split-binding"
  | "generated-id-collision"
  | "document-mismatch";

export interface NativeProjectClipFailure {
  readonly code: NativeProjectClipFailureCode;
  readonly message: string;
}

export type NativeProjectClipCommandResult =
  | { readonly ok: true; readonly document: NativeProjectDocument; readonly inverse: NativeProjectClipCommand }
  | {
      readonly ok: false;
      /** Failed commands return the exact original reference, never a partial clone. */
      readonly document: NativeProjectDocument;
      readonly failure: NativeProjectClipFailure;
    };

interface LocatedMove extends NativeProjectClipMove {
  readonly sourceTrackIndex: number;
  readonly sourceClipIndex: number;
  readonly clip: NativeProjectClip;
  readonly destinationTrackIndex: number;
}

interface LocatedClip {
  readonly trackIndex: number;
  readonly clipIndex: number;
  readonly track: NativeProjectTrack;
  readonly clip: NativeProjectClip;
}

const cloneDocument = (document: NativeProjectDocument): NativeProjectDocument =>
  parseNativeProjectDocument(JSON.parse(serializeNativeProjectDocument(document)));

const reject = (
  document: NativeProjectDocument,
  code: NativeProjectClipFailureCode,
  message: string,
): NativeProjectClipCommandResult => ({ ok: false, document, failure: { code, message } });

const succeed = (
  original: NativeProjectDocument,
  document: NativeProjectDocument,
): NativeProjectClipCommandResult => ({
  ok: true,
  document,
  inverse: { type: "restore-document", document: cloneDocument(original) },
});

const moveAddressKey = ({ sequenceId, trackId, clipId }: NativeProjectClipAddress): string =>
  JSON.stringify([sequenceId, trackId, clipId]);

const destinationKey = ({ trackId, startFrame }: NativeProjectClipDestination): string =>
  JSON.stringify([trackId, startFrame]);

/** Stable child clip ID: split commands are reproducible and collision-checkable. */
export const nativeSplitClipId = (clipId: string, splitFrame: number): string =>
  `native-split:${clipId}|frame:${splitFrame}`;

const nativeSplitTrackId = (trackId: string, splitClipId: string, parameterId: string): string =>
  `native-split-track:${trackId}|clip:${splitClipId}|parameter:${parameterId}`;

const nativeSplitBaselineKeyframeId = (trackId: string, splitFrame: number): string =>
  `native-split-baseline:${trackId}|frame:${splitFrame}`;

const locateClip = (
  document: NativeProjectDocument,
  address: NativeProjectClipAddress,
): LocatedClip | NativeProjectClipFailure => {
  if (document.sequence.id !== address.sequenceId) {
    return { code: "missing-sequence", message: `Sequence ${address.sequenceId} does not exist` };
  }
  const trackIndex = document.sequence.tracks.findIndex((track) => track.id === address.trackId);
  if (trackIndex < 0) {
    return { code: "missing-source-track", message: `Track ${address.trackId} does not exist` };
  }
  const track = document.sequence.tracks[trackIndex]!;
  const clipIndex = track.clips.findIndex((clip) => clip.id === address.clipId);
  if (clipIndex < 0) {
    return { code: "missing-clip", message: `Clip ${address.clipId} does not exist on track ${track.id}` };
  }
  return { trackIndex, clipIndex, track, clip: track.clips[clipIndex]! };
};

const compatible = (clip: NativeProjectClip, destination: NativeProjectTrack, document: NativeProjectDocument) => {
  const asset = document.assets.find((candidate) => candidate.id === clip.assetId);
  return !!asset && (destination.kind === "audio" ? asset.kind === "audio" : asset.kind !== "audio");
};

/** Validate every requested edit against the same original document before mutation. */
const locateMoves = (
  document: NativeProjectDocument,
  moves: readonly NativeProjectClipMove[],
): LocatedMove[] | NativeProjectClipFailure => {
  const addressed = new Set<string>();
  const destinations = new Set<string>();
  const located: LocatedMove[] = [];
  for (const move of moves) {
    if (document.sequence.id !== move.address.sequenceId) {
      return { code: "missing-sequence", message: `Sequence ${move.address.sequenceId} does not exist` };
    }
    if (!Number.isInteger(move.destination.startFrame) || move.destination.startFrame < 0) {
      return { code: "invalid-start-frame", message: "Destination startFrame must be a non-negative integer" };
    }
    const addressKey = moveAddressKey(move.address);
    if (addressed.has(addressKey)) {
      return { code: "duplicate-target", message: `Clip ${move.address.clipId} is targeted more than once` };
    }
    addressed.add(addressKey);
    const nextDestinationKey = destinationKey(move.destination);
    if (destinations.has(nextDestinationKey)) {
      return { code: "destination-collision", message: "Two moves have the same destination track and start frame" };
    }
    destinations.add(nextDestinationKey);

    const sourceTrackIndex = document.sequence.tracks.findIndex(
      (track) => track.id === move.address.trackId,
    );
    if (sourceTrackIndex < 0) {
      return { code: "missing-source-track", message: `Track ${move.address.trackId} does not exist` };
    }
    const sourceTrack = document.sequence.tracks[sourceTrackIndex]!;
    const sourceClipIndex = sourceTrack.clips.findIndex((clip) => clip.id === move.address.clipId);
    if (sourceClipIndex < 0) {
      return { code: "missing-clip", message: `Clip ${move.address.clipId} does not exist on track ${sourceTrack.id}` };
    }
    const destinationTrackIndex = document.sequence.tracks.findIndex(
      (track) => track.id === move.destination.trackId,
    );
    if (destinationTrackIndex < 0) {
      return {
        code: "missing-destination-track",
        message: `Destination track ${move.destination.trackId} does not exist`,
      };
    }
    const clip = sourceTrack.clips[sourceClipIndex]!;
    const destinationTrack = document.sequence.tracks[destinationTrackIndex]!;
    if (!compatible(clip, destinationTrack, document)) {
      return {
        code: "incompatible-destination",
        message: `Clip ${clip.id} cannot move to ${destinationTrack.kind} track ${destinationTrack.id}`,
      };
    }
    located.push({ ...move, sourceTrackIndex, sourceClipIndex, clip, destinationTrackIndex });
  }
  return located;
};

const isFailure = (value: LocatedMove[] | NativeProjectClipFailure): value is NativeProjectClipFailure =>
  !Array.isArray(value);

const isLocatedClipFailure = (
  value: LocatedClip | NativeProjectClipFailure,
): value is NativeProjectClipFailure => "code" in value;

const replaceClip = (
  document: NativeProjectDocument,
  location: LocatedClip,
  replacement: NativeProjectClip | readonly NativeProjectClip[],
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
              clips: track.clips.flatMap((clip, clipIndex) =>
                clipIndex === location.clipIndex ? replacement : [clip],
              ),
            },
      ),
    },
  });

const cloneOutgoing = <K extends NativeValueType>(
  outgoing: NativeParameterTrack<K>["keyframes"][number]["outgoing"],
) =>
  outgoing.type === "cubic-bezier"
    ? { type: outgoing.type, controlPoints: { ...outgoing.controlPoints } }
    : { type: outgoing.type };

/**
 * Rebase a native parameter track to a playable subrange. A generated frame-0
 * sample carries the original segment's outgoing interpolation, retaining the
 * exact value at a trim/split boundary without leaving invalid keyframes.
 */
const rebaseTrack = (
  track: NativeParameterTrack,
  fromFrame: number,
  untilFrameExclusive: number,
  nextTrackId: string,
): NativeParameterTrack => {
  const typed = track as NativeParameterTrack<NativeValueType>;
  const atBoundary = typed.keyframes.find((keyframe) => keyframe.frame === fromFrame);
  const prior = typed.keyframes.filter((keyframe) => keyframe.frame <= fromFrame).at(-1);
  const baseline = atBoundary ?? {
    id: nativeSplitBaselineKeyframeId(track.id, fromFrame),
    frame: fromFrame,
    value: evaluateNativeParameterTrack(typed, fromFrame),
    outgoing: cloneOutgoing((prior ?? typed.keyframes[0]!).outgoing),
  };
  const keyframes = [
    { ...baseline, frame: 0, outgoing: cloneOutgoing(baseline.outgoing) },
    ...typed.keyframes
      .filter((keyframe) => keyframe.frame > fromFrame && keyframe.frame < untilFrameExclusive)
      .map((keyframe) => ({
        ...keyframe,
        frame: keyframe.frame - fromFrame,
        outgoing: cloneOutgoing(keyframe.outgoing),
      })),
  ];
  return createNativeParameterTrack({
    id: nextTrackId,
    parameterId: typed.parameterId,
    valueType: typed.valueType,
    frameRate: typed.frameRate,
    keyframes,
  }) as NativeParameterTrack;
};

const rebasedTracks = (
  clip: NativeProjectClip,
  fromFrame: number,
  untilFrameExclusive: number,
  idForTrack: (track: NativeParameterTrack) => string,
): NativeParameterTrack[] =>
  clip.parameterTracks.map((track) => rebaseTrack(track, fromFrame, untilFrameExclusive, idForTrack(track)));

/**
 * Convert a timeline-frame delta to an exact integral source-frame delta.
 * Fractional source boundaries are not silently rounded because that would
 * make repeated trims/splits drift depending on command order.
 */
const exactSourceFrameDelta = (
  clip: NativeProjectClip,
  timelineFrameDelta: number,
): number | null => {
  const rate = clip.playbackRate ?? DEFAULT_NATIVE_PLAYBACK_RATE;
  const numerator = BigInt(timelineFrameDelta) * BigInt(rate.numerator);
  const denominator = BigInt(rate.denominator);
  if (numerator % denominator !== 0n) return null;
  const sourceDelta = numerator / denominator;
  if (sourceDelta > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(sourceDelta);
};

const applyTrimIn = (
  document: NativeProjectDocument,
  address: NativeProjectClipAddress,
  startFrame: number,
): NativeProjectClipCommandResult => {
  const location = locateClip(document, address);
  if (isLocatedClipFailure(location)) return reject(document, location.code, location.message);
  const delta = startFrame - location.clip.startFrame;
  if (!Number.isSafeInteger(startFrame) || delta < 0 || delta >= location.clip.durationFrames) {
    return reject(document, "invalid-trim", "Trim-in start must be an integer inside the clip");
  }
  const clip = location.clip;
  const sourceDelta = exactSourceFrameDelta(clip, delta);
  if (sourceDelta === null) {
    return reject(
      document,
      "non-integral-source-boundary",
      "Trim boundary does not map to an exact integral source frame at this playback rate",
    );
  }
  return succeed(
    document,
    replaceClip(document, location, {
      ...clip,
      startFrame,
      sourceInFrame: clip.sourceInFrame + sourceDelta,
      durationFrames: clip.durationFrames - delta,
      parameterTracks: rebasedTracks(clip, delta, clip.durationFrames, (track) => track.id),
    }),
  );
};

const applyTrimOut = (
  document: NativeProjectDocument,
  address: NativeProjectClipAddress,
  endFrameExclusive: number,
): NativeProjectClipCommandResult => {
  const location = locateClip(document, address);
  if (isLocatedClipFailure(location)) return reject(document, location.code, location.message);
  const nextDuration = endFrameExclusive - location.clip.startFrame;
  if (!Number.isSafeInteger(endFrameExclusive) || nextDuration <= 0 || nextDuration > location.clip.durationFrames) {
    return reject(document, "invalid-trim", "Trim-out end must be an integer inside the clip end");
  }
  const clip = location.clip;
  return succeed(
    document,
    replaceClip(document, location, {
      ...clip,
      durationFrames: nextDuration,
      parameterTracks: rebasedTracks(clip, 0, nextDuration, (track) => track.id),
    }),
  );
};

const applySplit = (
  document: NativeProjectDocument,
  address: NativeProjectClipAddress,
  splitFrame: number,
  rightBinding?: NativeClipDomBinding,
): NativeProjectClipCommandResult => {
  const location = locateClip(document, address);
  if (isLocatedClipFailure(location)) return reject(document, location.code, location.message);
  const clip = location.clip;
  const localFrame = splitFrame - clip.startFrame;
  if (!Number.isSafeInteger(splitFrame) || localFrame <= 0 || localFrame >= clip.durationFrames) {
    return reject(document, "invalid-split", "Split frame must be an integer strictly inside the clip");
  }
  const sourceDelta = exactSourceFrameDelta(clip, localFrame);
  if (sourceDelta === null) {
    return reject(
      document,
      "non-integral-source-boundary",
      "Split boundary does not map to an exact integral source frame at this playback rate",
    );
  }
  if (clip.binding && !rightBinding) {
    return reject(
      document,
      "missing-split-binding",
      "Splitting a bound clip requires an explicit unique binding for the right clip",
    );
  }
  const rightId = nativeSplitClipId(clip.id, splitFrame);
  if (document.sequence.tracks.some((track) => track.clips.some((candidate) => candidate.id === rightId))) {
    return reject(document, "generated-id-collision", `Split clip ID ${rightId} already exists`);
  }
  const left: NativeProjectClip = {
    ...clip,
    durationFrames: localFrame,
    parameterTracks: rebasedTracks(clip, 0, localFrame, (track) => track.id),
  };
  const right: NativeProjectClip = {
    ...clip,
    id: rightId,
    startFrame: splitFrame,
    durationFrames: clip.durationFrames - localFrame,
    sourceInFrame: clip.sourceInFrame + sourceDelta,
    ...(rightBinding ? { binding: rightBinding } : {}),
    parameterTracks: rebasedTracks(
      clip,
      localFrame,
      clip.durationFrames,
      (track) => nativeSplitTrackId(track.id, rightId, track.parameterId),
    ),
  };
  try {
    return succeed(document, replaceClip(document, location, [left, right]));
  } catch (error) {
    if (error instanceof NativeProjectDocumentValidationError) {
      if (error.issues.some((issue) => issue.code === "duplicate-binding")) {
        return reject(
          document,
          "duplicate-split-binding",
          "The right clip binding must be unique within the native project",
        );
      }
      if (error.issues.some((issue) => issue.code === "invalid-binding")) {
        return reject(document, "invalid-split-binding", "The right clip binding is invalid");
      }
    }
    throw error;
  }
};

const applyDeleteMany = (
  document: NativeProjectDocument,
  addresses: readonly NativeProjectClipAddress[],
): NativeProjectClipCommandResult => {
  const seen = new Set<string>();
  const locations: LocatedClip[] = [];
  for (const address of addresses) {
    const key = moveAddressKey(address);
    if (seen.has(key)) return reject(document, "duplicate-target", `Clip ${address.clipId} is targeted more than once`);
    seen.add(key);
    const location = locateClip(document, address);
    if (isLocatedClipFailure(location)) return reject(document, location.code, location.message);
    locations.push(location);
  }
  const removed = new Set(locations.map((location) => moveAddressKey({
    sequenceId: document.sequence.id,
    trackId: location.track.id,
    clipId: location.clip.id,
  })));
  return succeed(
    document,
    parseNativeProjectDocument({
      ...document,
      sequence: {
        ...document.sequence,
        tracks: document.sequence.tracks.map((track) => ({
          ...track,
          clips: track.clips.filter(
            (clip) => !removed.has(moveAddressKey({ sequenceId: document.sequence.id, trackId: track.id, clipId: clip.id })),
          ),
        })),
      },
    }),
  );
};

/**
 * Pure native move command. Clips are copied only to change `startFrame`; all
 * media-local state (source range, effects, static parameters, keyframes and
 * binding) is retained exactly. Multi-clip commands validate first and then
 * order destinations by frame plus durable source address, never input order.
 */
export const applyNativeProjectClipCommand = (
  document: NativeProjectDocument,
  command: NativeProjectClipCommand,
): NativeProjectClipCommandResult => {
  if (command.type === "restore-document") {
    if (command.document.id !== document.id) {
      return reject(document, "document-mismatch", "An inverse can only restore its source project");
    }
    return succeed(document, cloneDocument(command.document));
  }

  if (command.type === "trim-in") return applyTrimIn(document, command.address, command.startFrame);
  if (command.type === "trim-out") {
    return applyTrimOut(document, command.address, command.endFrameExclusive);
  }
  if (command.type === "split") {
    return applySplit(document, command.address, command.splitFrame, command.rightBinding);
  }
  if (command.type === "delete") return applyDeleteMany(document, [command.address]);
  if (command.type === "delete-many") return applyDeleteMany(document, command.addresses);

  const moves = command.type === "move" ? [command] : command.moves;
  const located = locateMoves(document, moves);
  if (isFailure(located)) return reject(document, located.code, located.message);

  const moving = new Set(located.map((move) => moveAddressKey(move.address)));
  const orderedMoves = [...located].sort(
    (left, right) =>
      left.destinationTrackIndex - right.destinationTrackIndex ||
      left.destination.startFrame - right.destination.startFrame ||
      moveAddressKey(left.address).localeCompare(moveAddressKey(right.address)),
  );
  const nextTracks = document.sequence.tracks.map((track, trackIndex) => {
    const stationary = track.clips
      .map((clip, clipIndex) => ({ clip, clipIndex, moving: moving.has(moveAddressKey({ sequenceId: document.sequence.id, trackId: track.id, clipId: clip.id })) }))
      .filter((entry) => !entry.moving)
      .map((entry) => ({ ...entry, stableOrder: entry.clipIndex }));
    const arrivals = orderedMoves
      .filter((move) => move.destinationTrackIndex === trackIndex)
      .map((move, index) => ({
        clip: { ...move.clip, startFrame: move.destination.startFrame },
        clipIndex: Number.MAX_SAFE_INTEGER,
        stableOrder: track.clips.length + index,
      }));
    return {
      ...track,
      clips: [...stationary, ...arrivals]
        .sort(
          (left, right) =>
            left.clip.startFrame - right.clip.startFrame || left.stableOrder - right.stableOrder,
        )
        .map((entry) => entry.clip),
    };
  });

  return succeed(
    document,
    parseNativeProjectDocument({
      ...document,
      sequence: { ...document.sequence, tracks: nextTracks },
    }),
  );
};
