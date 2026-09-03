import { projectFrameFromSeconds } from "./nativePropertyEditPlan";
import {
  parseNativeProjectDocument,
  type NativeClipDomBinding,
  type NativeProjectAssetKind,
  type NativeProjectClip,
  type NativeProjectDocument,
  type NativeProjectTrack,
  type NativeProjectTrackKind,
} from "./nativeProjectDocument";

export interface NativeTimelineAssetInsertion {
  readonly assetPath: string;
  readonly assetName?: string;
  readonly kind: NativeProjectAssetKind;
  readonly sourceFile: string;
  /** The exact identity returned by the compatibility insertion adapter. */
  readonly binding: Readonly<NativeClipDomBinding>;
  readonly requestedStartSeconds: number;
  readonly requestedDurationSeconds: number;
  readonly sourceDurationSeconds: number;
  readonly requestedTrack: number;
}

export type NativeTimelineAssetInsertPlanFailureCode =
  | "empty-insertion-set"
  | "unsupported-kind"
  | "invalid-asset-path"
  | "invalid-source-file"
  | "invalid-time"
  | "invalid-duration"
  | "source-out-of-bounds"
  | "invalid-track"
  | "incompatible-lane"
  | "invalid-binding"
  | "binding-source-mismatch"
  | "binding-collision"
  | "identity-collision";

export interface NativeTimelineAssetInsertPlanFailure {
  readonly code: NativeTimelineAssetInsertPlanFailureCode;
  readonly message: string;
  readonly insertionIndex?: number;
}

export type NativeTimelineAssetInsertionTimingResult =
  | {
      readonly ok: true;
      readonly startFrame: number;
      readonly durationFrames: number;
      readonly sourceDurationFrames: number;
      readonly compatibilityStartSeconds: number;
      readonly compatibilityDurationSeconds: number;
    }
  | { readonly ok: false; readonly failure: NativeTimelineAssetInsertPlanFailure };

export interface NativeTimelineAssetInsertPlanInput {
  readonly document: NativeProjectDocument;
  readonly insertions: readonly NativeTimelineAssetInsertion[];
}

export interface NativeTimelineAssetPlannedInsertion {
  readonly insertionIndex: number;
  readonly assetId: string;
  readonly clipId: string;
  readonly trackId: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly sourceDurationFrames: number;
  readonly compatibilityStartSeconds: number;
  readonly compatibilityDurationSeconds: number;
  readonly binding: Readonly<NativeClipDomBinding>;
}

export type NativeTimelineAssetInsertPlanResult =
  | {
      readonly ok: true;
      readonly document: NativeProjectDocument;
      readonly insertions: readonly NativeTimelineAssetPlannedInsertion[];
    }
  | { readonly ok: false; readonly failure: NativeTimelineAssetInsertPlanFailure };

const fail = (
  code: NativeTimelineAssetInsertPlanFailureCode,
  message: string,
  insertionIndex?: number,
): { readonly ok: false; readonly failure: NativeTimelineAssetInsertPlanFailure } => ({
  ok: false,
  failure: { code, message, ...(insertionIndex === undefined ? {} : { insertionIndex }) },
});

const stableIdPart = (value: string): string => `${value.length}:${value}`;
const stableAssetId = (kind: NativeProjectAssetKind, path: string): string =>
  `native-asset:${kind}:${stableIdPart(path)}`;
const stableTrackId = (track: number, kind: NativeProjectTrackKind): string =>
  `native-track:${track}:${kind}`;
const bindingIdentity = (binding: Readonly<NativeClipDomBinding>): string =>
  [
    `file:${stableIdPart(binding.sourceFile)}`,
    binding.hfId ? `hf:${stableIdPart(binding.hfId)}` : "",
    binding.domId ? `dom:${stableIdPart(binding.domId)}` : "",
    binding.selector ? `selector:${stableIdPart(binding.selector)}` : "",
    binding.selector ? `index:${binding.selectorIndex ?? 0}` : "",
  ].filter(Boolean).join("|");
const stableClipId = (binding: Readonly<NativeClipDomBinding>): string =>
  `native-clip:${bindingIdentity(binding)}`;
const sourceName = (source: string): string => source.split(/[\\/]/).at(-1) || source;
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const safeFrame = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const secondsFromFrame = (frame: number, document: NativeProjectDocument): number =>
  (frame * document.frameRate.denominator) / document.frameRate.numerator;

const trackKindFor = (kind: NativeProjectAssetKind): NativeProjectTrackKind =>
  kind === "audio" ? "audio" : "video";

const bindingKeys = (binding: Readonly<NativeClipDomBinding>): string[] => {
  const keys: string[] = [];
  if (binding.domId) keys.push(`${binding.sourceFile}\u0000domId\u0000${binding.domId}`);
  if (binding.hfId) keys.push(`${binding.sourceFile}\u0000hfId\u0000${binding.hfId}`);
  if (binding.selector) {
    keys.push(`${binding.sourceFile}\u0000selector\u0000${binding.selector}\u0000${binding.selectorIndex ?? 0}`);
  }
  return keys;
};

const validBinding = (binding: Readonly<NativeClipDomBinding>): boolean => {
  if (!nonEmpty(binding.sourceFile)) return false;
  const identifiers = [binding.domId, binding.hfId, binding.selector].filter(
    (value) => value !== undefined,
  );
  if (identifiers.length === 0 || identifiers.some((value) => !nonEmpty(value))) return false;
  if (binding.selectorIndex !== undefined) {
    if (!nonEmpty(binding.selector)) return false;
    if (!Number.isSafeInteger(binding.selectorIndex) || binding.selectorIndex < 0) return false;
  }
  return true;
};

/**
 * Resolve editor seconds once to the integer project timebase. Compatibility
 * seconds are derived back from those frames, so HTML and native playback do
 * not acquire separate rounding histories at rates such as 30000/1001.
 */
export function quantizeNativeTimelineAssetInsertion(
  document: NativeProjectDocument,
  insertion: Pick<
    NativeTimelineAssetInsertion,
    "requestedStartSeconds" | "requestedDurationSeconds" | "sourceDurationSeconds"
  >,
): NativeTimelineAssetInsertionTimingResult {
  if (!Number.isFinite(insertion.requestedStartSeconds) || insertion.requestedStartSeconds < 0) {
    return fail("invalid-time", "Asset start must be a finite non-negative time");
  }
  if (!Number.isFinite(insertion.requestedDurationSeconds) || insertion.requestedDurationSeconds <= 0) {
    return fail("invalid-duration", "Asset duration must be a finite positive time");
  }
  if (!Number.isFinite(insertion.sourceDurationSeconds) || insertion.sourceDurationSeconds <= 0) {
    return fail("invalid-duration", "Source duration must be a finite positive time");
  }
  const startFrame = projectFrameFromSeconds(insertion.requestedStartSeconds, document.frameRate);
  const durationFrames = projectFrameFromSeconds(insertion.requestedDurationSeconds, document.frameRate);
  const sourceDurationFrames = projectFrameFromSeconds(insertion.sourceDurationSeconds, document.frameRate);
  if (!safeFrame(startFrame)) return fail("invalid-time", "Asset start exceeds the exact project frame range");
  if (!safeFrame(durationFrames) || durationFrames <= 0) {
    return fail("invalid-duration", "Asset duration must span at least one project frame");
  }
  if (!safeFrame(sourceDurationFrames) || sourceDurationFrames <= 0) {
    return fail("invalid-duration", "Source duration must span at least one project frame");
  }
  if (durationFrames > sourceDurationFrames) {
    return fail("source-out-of-bounds", "Asset timeline duration exceeds its source duration");
  }
  return {
    ok: true,
    startFrame,
    durationFrames,
    sourceDurationFrames,
    compatibilityStartSeconds: secondsFromFrame(startFrame, document),
    compatibilityDurationSeconds: secondsFromFrame(durationFrames, document),
  };
}

interface Candidate extends NativeTimelineAssetPlannedInsertion {
  readonly input: NativeTimelineAssetInsertion;
  readonly trackKind: NativeProjectTrackKind;
}

/**
 * Plan a single native revision for one or many inserted assets. The caller
 * must supply the actual post-insertion DOM binding; provisional HTML IDs are
 * never promoted into durable clip identity.
 */
export function planNativeTimelineAssetInsertions(
  input: NativeTimelineAssetInsertPlanInput,
): NativeTimelineAssetInsertPlanResult {
  if (input.insertions.length === 0) {
    return fail("empty-insertion-set", "A native asset insertion requires at least one asset");
  }

  const occupiedBindingKeys = new Set(
    input.document.sequence.tracks.flatMap((track) =>
      track.clips.flatMap((clip) => clip.binding ? bindingKeys(clip.binding) : []),
    ),
  );
  const occupiedClipIds = new Set(
    input.document.sequence.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
  );
  const candidates: Candidate[] = [];

  for (const [insertionIndex, insertion] of input.insertions.entries()) {
    if (insertion.kind !== "video" && insertion.kind !== "audio" && insertion.kind !== "image") {
      return fail("unsupported-kind", "Only video, audio, and image assets can be inserted", insertionIndex);
    }
    if (!nonEmpty(insertion.assetPath)) {
      return fail("invalid-asset-path", "Asset path must be non-empty", insertionIndex);
    }
    if (!nonEmpty(insertion.sourceFile)) {
      return fail("invalid-source-file", "Compatibility source file must be non-empty", insertionIndex);
    }
    if (!Number.isSafeInteger(insertion.requestedTrack) || insertion.requestedTrack < 0) {
      return fail("invalid-track", "Requested track must be a non-negative integer", insertionIndex);
    }
    if (!validBinding(insertion.binding)) {
      return fail("invalid-binding", "Compatibility insertion did not return an exact binding", insertionIndex);
    }
    if (insertion.binding.sourceFile !== insertion.sourceFile) {
      return fail(
        "binding-source-mismatch",
        "Compatibility binding source does not match its insertion source",
        insertionIndex,
      );
    }
    for (const key of bindingKeys(insertion.binding)) {
      if (occupiedBindingKeys.has(key)) {
        return fail("binding-collision", "Compatibility binding is already owned by another clip", insertionIndex);
      }
      occupiedBindingKeys.add(key);
    }
    const clipId = stableClipId(insertion.binding);
    if (occupiedClipIds.has(clipId)) {
      return fail("identity-collision", `Deterministic clip ID ${clipId} already exists`, insertionIndex);
    }
    occupiedClipIds.add(clipId);

    const timing = quantizeNativeTimelineAssetInsertion(input.document, insertion);
    if (!timing.ok) return fail(timing.failure.code, timing.failure.message, insertionIndex);
    const trackKind = trackKindFor(insertion.kind);
    const laneOwner = input.document.sequence.tracks.find(
      (track) =>
        track.lane?.authoredTrack === insertion.requestedTrack ||
        track.lane?.displayTrack === insertion.requestedTrack,
    );
    if (laneOwner && laneOwner.kind !== trackKind) {
      return fail(
        "incompatible-lane",
        `Track ${insertion.requestedTrack} is occupied by ${laneOwner.kind} media`,
        insertionIndex,
      );
    }
    const trackId = laneOwner?.id ?? stableTrackId(insertion.requestedTrack, trackKind);
    const collidingTrack = input.document.sequence.tracks.find((track) => track.id === trackId);
    if (!laneOwner && collidingTrack) {
      return fail("identity-collision", `Deterministic track ID ${trackId} already exists`, insertionIndex);
    }
    const assetId = stableAssetId(insertion.kind, insertion.assetPath);
    const existingAsset = input.document.assets.find((asset) => asset.id === assetId);
    if (existingAsset && existingAsset.kind !== insertion.kind) {
      return fail("identity-collision", `Deterministic asset ID ${assetId} has incompatible media`, insertionIndex);
    }
    candidates.push({
      insertionIndex,
      input: insertion,
      trackKind,
      assetId,
      clipId,
      trackId,
      ...timing,
      binding: { ...insertion.binding },
    });
  }

  const candidateOrder = (left: Candidate, right: Candidate): number =>
    left.trackId.localeCompare(right.trackId) ||
    left.startFrame - right.startFrame ||
    left.clipId.localeCompare(right.clipId);
  const orderedCandidates = [...candidates].sort(candidateOrder);

  const assets = input.document.assets.map((asset) => ({ ...asset }));
  const newAssetIds = new Set<string>();
  for (const candidate of orderedCandidates) {
    const index = assets.findIndex((asset) => asset.id === candidate.assetId);
    if (index >= 0) {
      const current = assets[index]!;
      if (current.durationFrames < candidate.sourceDurationFrames) {
        assets[index] = { ...current, durationFrames: candidate.sourceDurationFrames };
      }
    } else {
      assets.push({
        id: candidate.assetId,
        kind: candidate.input.kind,
        name: nonEmpty(candidate.input.assetName)
          ? candidate.input.assetName
          : sourceName(candidate.input.assetPath),
        durationFrames: candidate.sourceDurationFrames,
      });
      newAssetIds.add(candidate.assetId);
    }
  }
  const existingAssets = assets.filter((asset) => !newAssetIds.has(asset.id));
  const newAssets = assets
    .filter((asset) => newAssetIds.has(asset.id))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));

  const tracks: NativeProjectTrack[] = input.document.sequence.tracks.map((track) => ({
    ...track,
    lane: track.lane ? { ...track.lane } : undefined,
    clips: track.clips.map((clip) => ({ ...clip })),
  }));
  const newTrackIds = new Set<string>();
  for (const candidate of orderedCandidates) {
    let track = tracks.find((entry) => entry.id === candidate.trackId);
    if (!track) {
      track = {
        id: candidate.trackId,
        kind: candidate.trackKind,
        lane: {
          authoredTrack: candidate.input.requestedTrack,
          displayTrack: candidate.input.requestedTrack,
        },
        clips: [],
      };
      tracks.push(track);
      newTrackIds.add(track.id);
    }
    const clip: NativeProjectClip = {
      id: candidate.clipId,
      assetId: candidate.assetId,
      binding: { ...candidate.binding },
      startFrame: candidate.startFrame,
      durationFrames: candidate.durationFrames,
      sourceInFrame: 0,
      playbackRate: { numerator: 1, denominator: 1 },
      muted: false,
      staticParameters: {},
      effects: [],
      parameterTracks: [],
    };
    track.clips.push(clip);
    track.clips.sort((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id));
  }
  const existingTracks = tracks.filter((track) => !newTrackIds.has(track.id));
  const newTracks = tracks
    .filter((track) => newTrackIds.has(track.id))
    .sort(
      (left, right) =>
        (left.lane?.authoredTrack ?? 0) - (right.lane?.authoredTrack ?? 0) ||
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id),
    );

  const document = parseNativeProjectDocument({
    ...input.document,
    assets: [...existingAssets, ...newAssets],
    sequence: {
      ...input.document.sequence,
      tracks: [...existingTracks, ...newTracks],
    },
  });
  return {
    ok: true,
    document,
    insertions: candidates.map(({ input: _input, trackKind: _trackKind, ...candidate }) => candidate),
  };
}
