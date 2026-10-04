/** Stable native project import path: schema, parser, and canonical serializer. */
import {
  DEFAULT_NATIVE_PLAYBACK_RATE,
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  NativeProjectDocumentValidationError,
  type NativeProjectDocument,
  type NativeProjectDocumentInput,
  type NativeProjectTrack,
  type NativeProjectTrackKind,
  type NativeProjectTrackLane,
} from "./nativeProjectDocumentTypes";
import { defaultTrackLane, cloneStaticParameters, isRecord } from "./nativeProjectDocumentValidationHelpers";
import { validateNativeProjectDocument } from "./nativeProjectDocumentValidation";

export * from "./nativeProjectDocumentTypes";
export { validateNativeProjectDocument } from "./nativeProjectDocumentValidation";

export function parseNativeProjectDocument(input: unknown): NativeProjectDocument {
  const issues = validateNativeProjectDocument(input);
  if (issues.length > 0) throw new NativeProjectDocumentValidationError(issues);
  const document = input as NativeProjectDocumentInput;
  return {
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    ...(document.mediaEngine ? { mediaEngine: document.mediaEngine } : {}),
    id: document.id,
    revision: document.revision,
    frameRate: { ...document.frameRate },
    canvas: { ...document.canvas },
    assets: document.assets.map((asset) => ({ ...asset })),
    sequence: {
      id: document.sequence.id,
      name: document.sequence.name,
      ...(document.sequence.durationFrames !== undefined ? { durationFrames: document.sequence.durationFrames } : {}),
      ...(document.sequence.audioGroups ? { audioGroups: document.sequence.audioGroups.map((group) => ({
        id: group.id,
        ...(group.label ? { label: group.label } : {}),
        volume: group.volume ?? 1,
        muted: group.muted ?? false,
        ...(group.fxChain ? { fxChain: group.fxChain } : {}),
        ...(group.automation ? { automation: group.automation } : {}),
      })) } : {}),
      tracks: document.sequence.tracks.map((track, trackIndex) => ({
        id: track.id,
        kind: track.kind,
        lane: {
          ...(track.lane ?? defaultTrackLane(trackIndex)),
        },
        clips: track.clips.map((clip) => ({
          id: clip.id,
          assetId: clip.assetId,
          ...(clip.audioGroupId ? { audioGroupId: clip.audioGroupId } : {}),
          ...(clip.audioFxChain ? { audioFxChain: clip.audioFxChain } : {}),
          ...(clip.audioAutomation ? { audioAutomation: clip.audioAutomation } : {}),
          ...(clip.audioDetachedFrom ? { audioDetachedFrom: clip.audioDetachedFrom } : {}),
          ...(clip.binding
            ? {
                binding: {
                  sourceFile: clip.binding.sourceFile,
                  ...(clip.binding.domId ? { domId: clip.binding.domId } : {}),
                  ...(clip.binding.hfId ? { hfId: clip.binding.hfId } : {}),
                  ...(clip.binding.selector ? { selector: clip.binding.selector } : {}),
                  ...(typeof clip.binding.selectorIndex === "number"
                    ? { selectorIndex: clip.binding.selectorIndex }
                    : {}),
                },
              }
            : {}),
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          sourceInFrame: clip.sourceInFrame,
          ...(clip.sourceInFraction ? { sourceInFraction: { ...clip.sourceInFraction } } : {}),
          playbackRate: {
            numerator: clip.playbackRate?.numerator ?? DEFAULT_NATIVE_PLAYBACK_RATE.numerator,
            denominator: clip.playbackRate?.denominator ?? DEFAULT_NATIVE_PLAYBACK_RATE.denominator,
          },
          muted: clip.muted ?? false,
          staticParameters: cloneStaticParameters(clip.staticParameters),
          effects: clip.effects.map((effect) => ({
            ...effect,
            ...(effect.parameters ? { parameters: { ...effect.parameters } } : {}),
          })),
          parameterTracks: clip.parameterTracks.map((track) => track),
        })),
      })),
    },
  };
}

export type NativeProjectTrackLaneQuery =
  | {
      readonly kind: NativeProjectTrackKind;
      readonly authoredTrack: number;
      readonly displayTrack?: number;
    }
  | {
      readonly kind: NativeProjectTrackKind;
      readonly displayTrack: number;
      readonly authoredTrack?: number;
    };

/**
 * Resolve a native track from explicit lane metadata. Early in-memory v1
 * objects that bypassed the parser retain the same deterministic index fallback
 * as parseNativeProjectDocument; track IDs are never inspected.
 */
export function findNativeProjectTrackByLane(
  document: NativeProjectDocument,
  query: NativeProjectTrackLaneQuery,
): NativeProjectTrack | null {
  const matches = document.sequence.tracks.filter((track, trackIndex) => {
    if (track.kind !== query.kind) return false;
    const lane = track.lane ?? defaultTrackLane(trackIndex);
    return (
      (query.authoredTrack === undefined || lane.authoredTrack === query.authoredTrack) &&
      (query.displayTrack === undefined || lane.displayTrack === query.displayTrack)
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

/** Validate then write stable JSON with ordered arrays and canonical object keys. */
export function serializeNativeProjectDocument(document: unknown): string {
  return `${JSON.stringify(canonicalize(parseNativeProjectDocument(document)), null, 2)}\n`;
}
