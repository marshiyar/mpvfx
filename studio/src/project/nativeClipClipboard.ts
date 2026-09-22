import {
  parseNativeProjectDocument,
  type NativeClipDomBinding,
  type NativeProjectClip,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import {
  resolveNativeClipSelection,
  type NativeSelectedElementReference,
} from "./nativePropertyEditPlan";

export interface NativeClipClipboardSnapshot {
  readonly projectId: string;
  readonly sequenceId: string;
  readonly frameRate: NativeProjectDocument["frameRate"];
  readonly clips: readonly ({
    readonly trackId: string;
    readonly clip: NativeProjectClip;
  } | null)[];
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function captureNativeClips(
  document: NativeProjectDocument,
  selections: readonly NativeSelectedElementReference[],
): NativeClipClipboardSnapshot {
  return {
    projectId: document.id,
    sequenceId: document.sequence.id,
    frameRate: { ...document.frameRate },
    clips: selections.map((selection) => {
      const result = resolveNativeClipSelection(document, selection);
      if (!result.ok) {
        if (result.failure.code === "clip-not-found") return null;
        throw new Error(result.failure.message);
      }
      return {
        trackId: result.located.trackId,
        clip: clone(result.located.clip),
      };
    }),
  };
}

/** Clone complete native instances; assets remain shared references, edits do not. */
export function pasteNativeClips(
  document: NativeProjectDocument,
  snapshot: NativeClipClipboardSnapshot,
  bindings: readonly Omit<NativeClipDomBinding, "sourceFile">[],
  sourceFile: string,
  deltaFrames: number,
  nonce: string,
): NativeProjectDocument {
  if (
    document.id !== snapshot.projectId ||
    document.sequence.id !== snapshot.sequenceId ||
    document.frameRate.numerator !== snapshot.frameRate.numerator ||
    document.frameRate.denominator !== snapshot.frameRate.denominator
  ) {
    throw new Error("Paste these clips in their original project and sequence.");
  }
  if (!Number.isSafeInteger(deltaFrames) || bindings.length !== snapshot.clips.length)
    throw new Error("Invalid clip paste timing or bindings.");
  const next = clone(document);
  snapshot.clips.forEach((entry, index) => {
    if (!entry) return;
    const track = next.sequence.tracks.find((candidate) => candidate.id === entry.trackId);
    if (!track) throw new Error("A copied clip's destination track no longer exists.");
    if (!next.assets.some((asset) => asset.id === entry.clip.assetId))
      throw new Error("A copied clip's source asset is no longer available.");
    const id = `copy:${nonce}:${index}`;
    const copied = clone(entry.clip);
    copied.id = id;
    copied.startFrame += deltaFrames;
    copied.binding = { ...bindings[index]!, sourceFile };
    copied.effects = copied.effects.map((effect, i) => ({
      ...effect,
      id: `${id}:effect:${i}`,
    }));
    copied.parameterTracks = copied.parameterTracks.map((parameter, i) => ({
      ...parameter,
      id: `${id}:parameter:${i}`,
      keyframes: parameter.keyframes.map((key, k) => ({
        ...key,
        id: `${id}:parameter:${i}:key:${k}`,
      })),
    }));
    track.clips.push(copied);
    track.clips.sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
  });
  return parseNativeProjectDocument(next);
}
