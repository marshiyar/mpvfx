import {
  createBakedEngine, installVkfEngine, uninstallVkfEngine,
  vkfEngine, vkfEngineInstalled, type VkfBakedTrack, type VkfEngine, type VkfTrack,
} from "../../../shared/engine/vkfEngine";
import { parseNativeProjectDocument, type NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import type { PreviewBakedTrack } from "../../../shared/preview/agentProtocol";

const bakedKey = (clipId: string, trackId: string, referenceIndex?: number): string =>
  `${clipId}\0${referenceIndex === undefined ? "main" : `reference:${referenceIndex}`}\0${trackId}`;

/** Parser validation constructs a fresh track before the parsed project exists. */
function trackFingerprint(track: VkfTrack): string {
  return JSON.stringify({
    valueType: track.valueType,
    keyframes: track.keyframes.map(keyframe => ({
      id: (keyframe as typeof keyframe & { id?: string }).id,
      frame: keyframe.frame,
      value: keyframe.value,
      outgoing: keyframe.outgoing,
      ...(keyframe.outgoingPath ? { outgoingPath: keyframe.outgoingPath } : {}),
    })),
  });
}

export function restorePreviewEngine(previous: VkfEngine | null): void {
  if (previous) installVkfEngine(previous);
  else uninstallVkfEngine();
}

/**
 * The trusted editor has already baked each track through C++. Match the exact
 * authored track shape during parser validation, then switch to parsed-object
 * identity for every runtime evaluation. Extra or missing sample entries fail.
 */
export function prepareBakedNativeProject(
  input: NativeProjectDocument,
  bakedTracks: PreviewBakedTrack[],
): { project: NativeProjectDocument; priorEngine: VkfEngine | null } {
  const priorEngine = vkfEngineInstalled() ? vkfEngine() : null;
  try {
    const supplied = new Map(bakedTracks.map(baked =>
      [bakedKey(baked.clipId, baked.trackId, baked.referenceIndex), baked]));
    if (supplied.size !== bakedTracks.length) throw new Error("invalid-request");
    const byFingerprint = new Map<string, VkfBakedTrack>();
    let rawCount = 0;
    const rawTrack = (clipId: string, track: VkfTrack & { id: string }, referenceIndex?: number) => {
      const baked = supplied.get(bakedKey(clipId, track.id, referenceIndex));
      if (!baked || baked.valueType !== track.valueType) throw new Error("invalid-request");
      const fingerprint = trackFingerprint(track);
      const existing = byFingerprint.get(fingerprint);
      if (existing && (existing.valueType !== baked.valueType ||
          JSON.stringify(existing.samples) !== JSON.stringify(baked.samples) ||
          JSON.stringify(existing.angles ?? null) !== JSON.stringify(baked.angles ?? null))) {
        throw new Error("invalid-request");
      }
      byFingerprint.set(fingerprint, baked);
      rawCount++;
    };
    for (const track of input.sequence.tracks) for (const clip of track.clips) {
      for (const parameterTrack of clip.parameterTracks) rawTrack(clip.id, parameterTrack);
      for (const [index, segment] of (clip.cropPivotSegments ?? []).entries()) {
        for (const parameterTrack of (segment.reference?.parameterTracks ?? [])) {
          rawTrack(clip.id, parameterTrack, index);
        }
      }
    }
    if (rawCount !== supplied.size) throw new Error("invalid-request");
    installVkfEngine(createBakedEngine("preview-baked-validation",
      track => byFingerprint.get(trackFingerprint(track))));
    const project = parseNativeProjectDocument(input);
    const byIdentity = new WeakMap<object, VkfBakedTrack>();
    let parsedCount = 0;
    const bind = (clipId: string, tracks: typeof project.sequence.tracks[number]["clips"][number]["parameterTracks"],
      durationFrames: number, referenceIndex?: number) => {
      for (const parameterTrack of tracks) {
        const baked = supplied.get(bakedKey(clipId, parameterTrack.id, referenceIndex));
        const components = parameterTrack.valueType === "number" ? 1 : parameterTrack.valueType === "vec2" ? 2 : 4;
        const requiredFrames = Math.max(durationFrames,
          ...parameterTrack.keyframes.map(keyframe => keyframe.frame + 1));
        if (!baked || baked.valueType !== parameterTrack.valueType ||
            baked.samples.length < requiredFrames * components ||
            baked.samples.length % components !== 0 ||
            (parameterTrack.autoRotate && (!baked.angles || baked.angles.length < requiredFrames))) {
          throw new Error("invalid-request");
        }
        byIdentity.set(parameterTrack, baked);
        parsedCount++;
      }
    };
    for (const track of project.sequence.tracks) for (const clip of track.clips) {
      bind(clip.id, clip.parameterTracks, clip.durationFrames);
      for (const [index, segment] of (clip.cropPivotSegments ?? []).entries()) {
        if (segment.reference) bind(clip.id, segment.reference.parameterTracks,
          segment.reference.durationFrames, index);
      }
    }
    if (parsedCount !== supplied.size) throw new Error("invalid-request");
    installVkfEngine(createBakedEngine("preview-baked", track => byIdentity.get(track)));
    return { project, priorEngine };
  } catch (error) {
    restorePreviewEngine(priorEngine);
    throw error;
  }
}
