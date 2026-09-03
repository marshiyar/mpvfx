import {
  applyNativeProjectKeyframeCommand,
  type NativeProjectKeyframeCommand,
  type NativeProjectParameterAddress,
} from "../../project/nativeProjectKeyframeCommands";
import type { NativeProjectDocument } from "../../project/nativeProjectDocument";

export interface NativeSelectedKeyframeAddress {
  readonly address: NativeProjectParameterAddress;
  readonly frame: number;
}

export interface NativeKeyframeProjectCommit {
  readonly document: NativeProjectDocument;
  readonly inverse: NativeProjectKeyframeCommand;
  readonly label: string;
}

export interface DeleteSelectedKeyframesSession {
  readonly nativeDocument?: NativeProjectDocument | null;
  readonly nativeSelection?: readonly NativeSelectedKeyframeAddress[];
  readonly commitNativeProject?: (commit: NativeKeyframeProjectCommit) => Promise<boolean>;
  readonly deleteLegacySelectedKeyframes: () => Promise<boolean>;
}

export const nativeParameterAddressKey = (address: NativeProjectParameterAddress): string =>
  JSON.stringify([
    address.sequenceId,
    address.trackId,
    address.clipId,
    address.parameterId,
  ]);

/** Route native selections atomically; legacy selection remains an opaque fallback. */
export const deleteSelectedKeyframes = async (
  session: DeleteSelectedKeyframesSession,
): Promise<boolean> => {
  const selection = session.nativeSelection ?? [];
  if (selection.length === 0) {
    try {
      return await session.deleteLegacySelectedKeyframes();
    } catch {
      return false;
    }
  }
  if (!session.nativeDocument || !session.commitNativeProject) return false;

  const grouped = new Map<
    string,
    { address: NativeProjectParameterAddress; frames: Set<number> }
  >();
  for (const selected of selection) {
    const key = nativeParameterAddressKey(selected.address);
    const group = grouped.get(key) ?? { address: selected.address, frames: new Set<number>() };
    group.frames.add(selected.frame);
    grouped.set(key, group);
  }
  const commands = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => ({
      type: "delete-many" as const,
      address: group.address,
      frames: [...group.frames].sort((left, right) => left - right),
    }));
  const result = applyNativeProjectKeyframeCommand(session.nativeDocument, {
    type: "batch",
    commands,
  });
  if (!result.ok) return false;

  try {
    return await session.commitNativeProject({
      document: result.document,
      inverse: result.inverse,
      label: "Delete keyframes",
    });
  } catch {
    return false;
  }
};
