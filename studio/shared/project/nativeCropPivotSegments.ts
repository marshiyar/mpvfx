import type { NativeCropPivotSegment, NativeProjectClip, NativeProjectDocument } from "./nativeProjectDocumentTypes";
import type { NativeParameterTrack, Vec2Value } from "./nativeKeyframeTypes";

/** Attach the pivot only to rotation intervals touched by this gesture. Static
 * rotation has no interpolation interval and needs no persistent correction. */
export function markNativeCropPivotIntervals(
  document: NativeProjectDocument,
  clipId: string,
  localFrame: number,
  offsetFraction: Vec2Value,
): NativeProjectDocument {
  let changed = false;
  const tracks = document.sequence.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      if (clip.id !== clipId) return clip;
      const rotation = clip.parameterTracks.find((item) => item.parameterId === "transform.rotation");
      const keys = rotation?.keyframes ?? [];
      const index = keys.findIndex((key) => key.frame === localFrame);
      if (index < 0) return clip;
      const pairs = [[keys[index - 1], keys[index]], [keys[index], keys[index + 1]]]
        .filter((pair): pair is [typeof keys[number], typeof keys[number]] => Boolean(pair[0] && pair[1]));
      if (!pairs.length) return clip;
      const additions: NativeCropPivotSegment[] = pairs.map(([start, end]) => ({
        startRotationKeyId: start.id,
        endRotationKeyId: end.id,
        offsetFraction: { ...offsetFraction },
      }));
      const replaced = new Set(additions.map((segment) =>
        JSON.stringify([segment.startRotationKeyId, segment.endRotationKeyId])));
      const frameById = new Map(keys.map((key) => [key.id, key.frame]));
      const affectedStart = pairs[0]![0].frame;
      const affectedEnd = pairs.at(-1)![1].frame;
      changed = true;
      return { ...clip, cropPivotSegments: [
        ...(clip.cropPivotSegments ?? []).filter((segment) => {
          if (replaced.has(JSON.stringify([segment.startRotationKeyId, segment.endRotationKeyId]))) return false;
          const oldStart = frameById.get(segment.startRotationKeyId);
          const oldEnd = frameById.get(segment.endRotationKeyId);
          return oldStart === undefined || oldEnd === undefined ||
            oldEnd <= affectedStart || oldStart >= affectedEnd;
        }),
        ...additions,
      ] };
    }),
  }));
  return changed ? { ...document, sequence: { ...document.sequence, tracks } } : document;
}

/** A deleted or reordered rotation key cannot leave a dormant marker that may
 * later attach to a different interval by accident. */
export function validNativeCropPivotSegments(
  segments: readonly NativeCropPivotSegment[] | undefined,
  tracks: readonly NativeParameterTrack[],
): NativeCropPivotSegment[] | undefined {
  if (!segments) return undefined;
  const rotation = tracks.find((track) => track.parameterId === "transform.rotation");
  const frameById = new Map(rotation?.keyframes.map((key) => [key.id, key.frame]) ?? []);
  return segments.filter((segment) => {
    const start = frameById.get(segment.startRotationKeyId);
    const end = frameById.get(segment.endRotationKeyId);
    return start !== undefined && end !== undefined && end > start;
  });
}

/** Editing geometry after a slice makes its original interpolation snapshot
 * obsolete. Keep the pivot interval and derive it from the newly authored keys. */
export function currentNativeCropPivotReferences(
  segments: readonly NativeCropPivotSegment[] | undefined,
  before: readonly NativeParameterTrack[],
  after: readonly NativeParameterTrack[],
): NativeCropPivotSegment[] | undefined {
  if (!segments) return undefined;
  const geometry = new Set([
    "transform.position", "transform.position.x", "transform.position.y",
    "transform.rotation", "transform.scale", "transform.scaleX", "transform.scaleY",
    "layout.width", "layout.height",
  ]);
  const oldGeometry = before.filter((track) => geometry.has(track.parameterId));
  const newGeometry = after.filter((track) => geometry.has(track.parameterId));
  if (JSON.stringify(oldGeometry) === JSON.stringify(newGeometry)) return [...segments];
  return segments.map(({ reference: _reference, ...segment }) => segment);
}

/** Engine slice creates new boundary keys at a trim/split. Preserve the marked
 * portion by linking to those new keys in the rebased local frame. */
export function rebaseNativeCropPivotSegments(
  clip: NativeProjectClip,
  rebasedTracks: readonly NativeParameterTrack[],
  fromFrame: number,
  untilFrameExclusive: number,
): NativeCropPivotSegment[] | undefined {
  if (!clip.cropPivotSegments) return undefined;
  const before = clip.parameterTracks.find((track) => track.parameterId === "transform.rotation");
  const after = rebasedTracks.find((track) => track.parameterId === "transform.rotation");
  if (!before || !after) return [];
  const originalFrames = new Map(before.keyframes.map((key) => [key.id, key.frame]));
  const result: NativeCropPivotSegment[] = [];
  const seen = new Set<string>();
  for (const segment of clip.cropPivotSegments) {
    const oldStart = originalFrames.get(segment.startRotationKeyId);
    const oldEnd = originalFrames.get(segment.endRotationKeyId);
    if (oldStart === undefined || oldEnd === undefined || oldEnd <= oldStart) continue;
    const firstFrame = Math.max(oldStart, fromFrame) - fromFrame;
    const lastFrame = Math.min(oldEnd, untilFrameExclusive - 1) - fromFrame;
    if (lastFrame <= firstFrame) continue;
    const first = after.keyframes.find((key) => key.frame === firstFrame);
    const last = after.keyframes.find((key) => key.frame === lastFrame);
    if (!first || !last) continue;
    const pair = JSON.stringify([first.id, last.id]);
    if (seen.has(pair)) continue;
    seen.add(pair);
    result.push({ startRotationKeyId: first.id, endRotationKeyId: last.id,
      offsetFraction: { ...segment.offsetFraction },
      reference: segment.reference ? {
        ...segment.reference,
        frameOffset: segment.reference.frameOffset + fromFrame,
      } : {
        frameOffset: fromFrame,
        durationFrames: clip.durationFrames,
        startRotationKeyId: segment.startRotationKeyId,
        endRotationKeyId: segment.endRotationKeyId,
        parameterTracks: clip.parameterTracks,
        staticParameters: clip.staticParameters,
      } });
  }
  return result;
}

/** Clipboard paste regenerates key IDs to keep duplicate clips independent. */
export function remapNativeCropPivotKeyIds(
  segments: readonly NativeCropPivotSegment[] | undefined,
  keyIdMap: ReadonlyMap<string, string>,
): NativeCropPivotSegment[] | undefined {
  return segments?.flatMap((segment) => {
    const startRotationKeyId = keyIdMap.get(segment.startRotationKeyId);
    const endRotationKeyId = keyIdMap.get(segment.endRotationKeyId);
    return startRotationKeyId && endRotationKeyId ? [{
      startRotationKeyId, endRotationKeyId,
      offsetFraction: { ...segment.offsetFraction },
      ...(segment.reference ? { reference: segment.reference } : {}),
    }] : [];
  });
}
