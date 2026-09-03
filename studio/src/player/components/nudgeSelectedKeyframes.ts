import {
  applyNativeProjectKeyframeCommand,
  type NativeProjectParameterAddress,
} from "../../project/nativeProjectKeyframeCommands";
import type { NativeProjectClip, NativeProjectDocument } from "../../project/nativeProjectDocument";
import {
  nativeParameterAddressKey,
  type NativeKeyframeProjectCommit,
  type NativeSelectedKeyframeAddress,
} from "./deleteSelectedKeyframes";

export interface NudgeSelectedKeyframesSession {
  readonly nativeDocument?: NativeProjectDocument | null;
  readonly nativeSelection?: readonly NativeSelectedKeyframeAddress[];
  readonly commitNativeProject?: (commit: NativeKeyframeProjectCommit) => Promise<boolean>;
  readonly onNativeSelectionCommitted?: (
    selection: readonly NativeSelectedKeyframeAddress[],
  ) => void;
  readonly nudgeLegacySelectedKeyframes: (direction: -1 | 1, large: boolean) => Promise<boolean>;
}

interface LocatedParameter {
  readonly clip: NativeProjectClip;
  readonly keyframeFrames: readonly number[];
}

const locateParameter = (
  document: NativeProjectDocument,
  address: NativeProjectParameterAddress,
): LocatedParameter | null => {
  if (document.sequence.id !== address.sequenceId) return null;
  const track = document.sequence.tracks.find((candidate) => candidate.id === address.trackId);
  const clip = track?.clips.find((candidate) => candidate.id === address.clipId);
  const parameter = clip?.parameterTracks.find(
    (candidate) => candidate.parameterId === address.parameterId,
  );
  return clip && parameter
    ? { clip, keyframeFrames: parameter.keyframes.map((keyframe) => keyframe.frame) }
    : null;
};

const movementCapacity = (
  clip: NativeProjectClip,
  authoredFrames: readonly number[],
  selectedFrames: ReadonlySet<number>,
  direction: -1 | 1,
): number => {
  let capacity = Number.POSITIVE_INFINITY;
  const stationary = authoredFrames.filter((frame) => !selectedFrames.has(frame));
  for (const frame of selectedFrames) {
    const boundaryCapacity = direction > 0 ? clip.durationFrames - 1 - frame : frame;
    capacity = Math.min(capacity, boundaryCapacity);
    const neighbor = direction > 0
      ? stationary.filter((candidate) => candidate > frame).sort((a, b) => a - b)[0]
      : stationary.filter((candidate) => candidate < frame).sort((a, b) => b - a)[0];
    if (neighbor !== undefined) {
      capacity = Math.min(capacity, Math.abs(neighbor - frame) - 1);
    }
  }
  return capacity;
};

/** Frame-exact native nudge with one shared, collision-safe clamped delta. */
export const nudgeSelectedKeyframes = async (
  session: NudgeSelectedKeyframesSession,
  direction: -1 | 1,
  large: boolean,
): Promise<boolean> => {
  const selection = session.nativeSelection ?? [];
  if (selection.length === 0) {
    try {
      return await session.nudgeLegacySelectedKeyframes(direction, large);
    } catch {
      return false;
    }
  }
  if (!session.nativeDocument || !session.commitNativeProject) return false;
  if (selection.some((selected) => !Number.isInteger(selected.frame))) return false;

  const grouped = new Map<
    string,
    { address: NativeProjectParameterAddress; frames: Set<number>; located: LocatedParameter }
  >();
  for (const selected of selection) {
    const key = nativeParameterAddressKey(selected.address);
    let group = grouped.get(key);
    if (!group) {
      const located = locateParameter(session.nativeDocument, selected.address);
      if (!located) return false;
      group = { address: selected.address, frames: new Set<number>(), located };
      grouped.set(key, group);
    }
    if (!group.located.keyframeFrames.includes(selected.frame)) return false;
    group.frames.add(selected.frame);
  }

  const requestedFrames = large ? 10 : 1;
  let sharedCapacity = requestedFrames;
  for (const group of grouped.values()) {
    sharedCapacity = Math.min(
      sharedCapacity,
      movementCapacity(group.located.clip, group.located.keyframeFrames, group.frames, direction),
    );
  }
  if (!Number.isFinite(sharedCapacity) || sharedCapacity < 1) return false;
  const deltaFrames = direction * Math.min(requestedFrames, Math.floor(sharedCapacity));

  const commands = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => ({
      type: "move-many" as const,
      address: group.address,
      frames: [...group.frames].sort((left, right) => left - right),
      deltaFrames,
    }));
  const result = applyNativeProjectKeyframeCommand(session.nativeDocument, {
    type: "batch",
    commands,
  });
  if (!result.ok) return false;

  let committed = false;
  try {
    committed = await session.commitNativeProject({
      document: result.document,
      inverse: result.inverse,
      label: "Nudge keyframes",
    });
  } catch {
    return false;
  }
  if (!committed) return false;
  session.onNativeSelectionCommitted?.(
    selection.map((selected) => ({ ...selected, frame: selected.frame + deltaFrames })),
  );
  return true;
};
