import type { TimelineElement } from "../player/store/timelineElement";
import { validateRationalFrameRate, type RationalFrameRate } from "./nativeKeyframeTypes";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeCanvas,
  type NativeClipDomBinding,
  type NativeProjectAsset,
  type NativeProjectAssetKind,
  type NativeProjectClip,
  type NativeProjectDocument,
  type NativePlaybackRate,
  type NativeProjectTrack,
  type NativeProjectTrackKind,
} from "./nativeProjectDocument";

export interface NativeProjectBootstrapInput {
  readonly projectId: string;
  readonly sequenceId: string;
  readonly sequenceName: string;
  readonly frameRate: RationalFrameRate;
  readonly canvas: NativeCanvas;
  readonly elements: readonly TimelineElement[];
}

export type NativeProjectBootstrapDiagnosticCode =
  | "invalid-project-settings"
  | "ignored-structural"
  | "unsupported-media-row"
  | "missing-source-file"
  | "missing-exact-binding"
  | "invalid-selector-index"
  | "duplicate-binding"
  | "missing-media-source"
  | "invalid-track"
  | "invalid-timing"
  | "source-out-of-bounds";

export interface NativeProjectBootstrapDiagnostic {
  readonly code: NativeProjectBootstrapDiagnosticCode;
  readonly disposition: "ignored" | "legacy-only" | "project-fatal";
  readonly elementId?: string;
  readonly message: string;
}

export type NativeProjectBootstrapResult =
  | {
      readonly ok: true;
      readonly document: NativeProjectDocument;
      readonly diagnostics: readonly NativeProjectBootstrapDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly document: null;
      readonly diagnostics: readonly NativeProjectBootstrapDiagnostic[];
    };

interface BootstrapCandidate {
  readonly element: TimelineElement;
  readonly kind: NativeProjectAssetKind;
  readonly trackKind: NativeProjectTrackKind;
  readonly authoredTrack: number;
  readonly displayTrack: number;
  readonly binding: NativeClipDomBinding;
  readonly source: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly sourceInFrame: number;
  readonly sourceDurationFrames: number;
  readonly playbackRate: NativePlaybackRate;
}

const stableIdPart = (value: string): string => `${value.length}:${value}`;
const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;
const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const frameFromSeconds = (seconds: number, frameRate: RationalFrameRate): number =>
  Math.floor((seconds * frameRate.numerator) / frameRate.denominator + 1e-9);

const greatestCommonDivisor = (left: number, right: number): number => {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
};

/**
 * Convert the finite authored TimelineElement speed to the native document's
 * integer-only contract. Continued fractions preserve ordinary editor rates
 * (1/2, 5/4, 1001/1000) exactly without carrying binary-float noise into the
 * project file. The denominator bound keeps both members safe integers.
 */
const rationalPlaybackRate = (value: number): NativePlaybackRate => {
  const maximumDenominator = 1_000_000;
  let fraction = value;
  let previousNumerator = 0;
  let numerator = 1;
  let previousDenominator = 1;
  let denominator = 0;

  for (let iteration = 0; iteration < 64; iteration += 1) {
    const whole = Math.floor(fraction);
    const nextNumerator = whole * numerator + previousNumerator;
    const nextDenominator = whole * denominator + previousDenominator;
    if (
      nextDenominator > maximumDenominator ||
      !Number.isSafeInteger(nextNumerator) ||
      !Number.isSafeInteger(nextDenominator)
    ) break;
    previousNumerator = numerator;
    numerator = nextNumerator;
    previousDenominator = denominator;
    denominator = nextDenominator;
    if (Math.abs(value - numerator / denominator) <= Number.EPSILON * Math.max(1, value)) break;
    const remainder = fraction - whole;
    if (remainder <= Number.EPSILON) break;
    fraction = 1 / remainder;
  }

  if (numerator <= 0 || denominator <= 0) return { numerator: 1, denominator: 1 };
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
};

const sourceFramesConsumed = (durationFrames: number, playbackRate: NativePlaybackRate): number => {
  const numerator = BigInt(durationFrames) * BigInt(playbackRate.numerator);
  const denominator = BigInt(playbackRate.denominator);
  return Number((numerator + denominator - 1n) / denominator);
};

const mediaKind = (
  element: TimelineElement,
): { kind: NativeProjectAssetKind; trackKind: NativeProjectTrackKind } | null => {
  const tag = element.tag.toLowerCase();
  if (tag === "video") return { kind: "video", trackKind: "video" };
  if (tag === "audio") return { kind: "audio", trackKind: "audio" };
  if (tag === "img" || tag === "image") return { kind: "image", trackKind: "video" };
  return null;
};

const exactBinding = (
  element: TimelineElement,
): NativeClipDomBinding | NativeProjectBootstrapDiagnostic => {
  if (!nonEmpty(element.sourceFile)) {
    return {
      code: "missing-source-file",
      disposition: "legacy-only",
      elementId: element.id,
      message: "Media row has no exact source-file scope",
    };
  }
  const domId = nonEmpty(element.domId) ? element.domId : undefined;
  const hfId = nonEmpty(element.hfId) ? element.hfId : undefined;
  const selector = nonEmpty(element.selector) ? element.selector : undefined;
  if (element.selectorIndex !== undefined) {
    if (!selector || !Number.isInteger(element.selectorIndex) || element.selectorIndex < 0) {
      return {
        code: "invalid-selector-index",
        disposition: "legacy-only",
        elementId: element.id,
        message: "selectorIndex requires an exact selector and a non-negative integer",
      };
    }
  }
  if (!domId && !hfId && !selector) {
    return {
      code: "missing-exact-binding",
      disposition: "legacy-only",
      elementId: element.id,
      message: "Media row has no exact DOM, hf-id, or selector identity",
    };
  }
  return {
    sourceFile: element.sourceFile,
    ...(domId ? { domId } : {}),
    ...(hfId ? { hfId } : {}),
    ...(selector ? { selector } : {}),
    ...(element.selectorIndex !== undefined ? { selectorIndex: element.selectorIndex } : {}),
  };
};

const isDiagnostic = (
  value: NativeClipDomBinding | NativeProjectBootstrapDiagnostic,
): value is NativeProjectBootstrapDiagnostic => "code" in value;

const bindingKeys = (binding: NativeClipDomBinding): string[] => {
  const scope = stableIdPart(binding.sourceFile);
  const keys: string[] = [];
  if (binding.hfId) keys.push(`${scope}|hf:${stableIdPart(binding.hfId)}`);
  if (binding.domId) keys.push(`${scope}|dom:${stableIdPart(binding.domId)}`);
  if (binding.selector) {
    keys.push(
      `${scope}|selector:${stableIdPart(binding.selector)}|index:${binding.selectorIndex ?? 0}`,
    );
  }
  return keys;
};

const bindingIdentity = (binding: NativeClipDomBinding): string =>
  [
    `file:${stableIdPart(binding.sourceFile)}`,
    binding.hfId ? `hf:${stableIdPart(binding.hfId)}` : "",
    binding.domId ? `dom:${stableIdPart(binding.domId)}` : "",
    binding.selector ? `selector:${stableIdPart(binding.selector)}` : "",
    binding.selector ? `index:${binding.selectorIndex ?? 0}` : "",
  ]
    .filter(Boolean)
    .join("|");

const assetId = (kind: NativeProjectAssetKind, source: string): string =>
  `native-asset:${kind}:${stableIdPart(source)}`;
const trackId = (authoredTrack: number, kind: NativeProjectTrackKind): string =>
  `native-track:${authoredTrack}:${kind}`;
const clipId = (binding: NativeClipDomBinding): string =>
  `native-clip:${bindingIdentity(binding)}`;
const sourceName = (source: string): string => source.split(/[\\/]/).at(-1) || source;

const diagnostic = (
  code: NativeProjectBootstrapDiagnosticCode,
  element: TimelineElement,
  message: string,
  disposition: NativeProjectBootstrapDiagnostic["disposition"] = "legacy-only",
): NativeProjectBootstrapDiagnostic => ({ code, disposition, elementId: element.id, message });

export const bootstrapNativeProjectFromTimeline = (
  input: NativeProjectBootstrapInput,
): NativeProjectBootstrapResult => {
  try {
    validateRationalFrameRate(input.frameRate);
    parseNativeProjectDocument({
      schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
      id: input.projectId,
      revision: 0,
      frameRate: input.frameRate,
      canvas: input.canvas,
      assets: [],
      sequence: { id: input.sequenceId, name: input.sequenceName, tracks: [] },
    });
  } catch (error) {
    return {
      ok: false,
      document: null,
      diagnostics: [
        {
          code: "invalid-project-settings",
          disposition: "project-fatal",
          message: error instanceof Error ? error.message : "Invalid native project settings",
        },
      ],
    };
  }

  const diagnostics: NativeProjectBootstrapDiagnostic[] = [];
  const candidates: BootstrapCandidate[] = [];
  for (const element of input.elements) {
    if (element.structuralRole === "composition-root") {
      diagnostics.push(
        diagnostic(
          "ignored-structural",
          element,
          "Composition-root rows are adapter structure, not native media clips",
          "ignored",
        ),
      );
      continue;
    }
    const kind = mediaKind(element);
    if (!kind) {
      diagnostics.push(
        diagnostic(
          "unsupported-media-row",
          element,
          `Timeline tag ${element.tag} is not video, audio, or image media`,
          "ignored",
        ),
      );
      continue;
    }
    if (!nonEmpty(element.src)) {
      diagnostics.push(diagnostic("missing-media-source", element, "Media row has no source asset"));
      continue;
    }
    const binding = exactBinding(element);
    if (isDiagnostic(binding)) {
      diagnostics.push(binding);
      continue;
    }
    const authoredTrack = element.authoredTrack ?? element.track;
    const displayTrack = element.track;
    if (
      !Number.isInteger(authoredTrack) ||
      authoredTrack < 0 ||
      !Number.isInteger(displayTrack) ||
      displayTrack < 0
    ) {
      diagnostics.push(
        diagnostic(
          "invalid-track",
          element,
          "Authored and display media tracks must be non-negative integers",
        ),
      );
      continue;
    }
    if (
      !finiteNonNegative(element.start) ||
      !finitePositive(element.duration) ||
      (element.playbackStart !== undefined && !finiteNonNegative(element.playbackStart)) ||
      (element.playbackRate !== undefined && !finitePositive(element.playbackRate)) ||
      (element.sourceDuration !== undefined && !finitePositive(element.sourceDuration))
    ) {
      diagnostics.push(
        diagnostic("invalid-timing", element, "Media timing values must be finite and non-negative"),
      );
      continue;
    }
    const startFrame = frameFromSeconds(element.start, input.frameRate);
    const durationFrames = frameFromSeconds(element.duration, input.frameRate);
    const sourceInFrame = frameFromSeconds(element.playbackStart ?? 0, input.frameRate);
    const playbackRate = rationalPlaybackRate(element.playbackRate ?? 1);
    if (durationFrames <= 0) {
      diagnostics.push(
        diagnostic("invalid-timing", element, "Media duration does not span an integer project frame"),
      );
      continue;
    }
    const requiredSourceFrames = sourceInFrame + sourceFramesConsumed(durationFrames, playbackRate);
    const sourceDurationFrames =
      element.sourceDuration === undefined
        ? requiredSourceFrames
        : frameFromSeconds(element.sourceDuration, input.frameRate);
    if (sourceDurationFrames < requiredSourceFrames) {
      diagnostics.push(
        diagnostic(
          "source-out-of-bounds",
          element,
          "Playback source range exceeds the declared source duration",
        ),
      );
      continue;
    }
    candidates.push({
      element,
      kind: kind.kind,
      trackKind: kind.trackKind,
      authoredTrack,
      displayTrack,
      binding,
      source: element.src,
      startFrame,
      durationFrames,
      sourceInFrame,
      sourceDurationFrames,
      playbackRate,
    });
  }

  const bindingOwners = new Map<string, BootstrapCandidate[]>();
  for (const candidate of candidates) {
    for (const key of bindingKeys(candidate.binding)) {
      const owners = bindingOwners.get(key) ?? [];
      owners.push(candidate);
      bindingOwners.set(key, owners);
    }
  }
  const duplicates = new Set<BootstrapCandidate>();
  for (const owners of bindingOwners.values()) {
    if (owners.length > 1) owners.forEach((owner) => duplicates.add(owner));
  }
  for (const duplicate of [...duplicates].sort((left, right) => left.element.id.localeCompare(right.element.id))) {
    diagnostics.push(
      diagnostic(
        "duplicate-binding",
        duplicate.element,
        "Exact clip binding is shared by multiple timeline rows",
      ),
    );
  }
  const laneConflicts = new Set<BootstrapCandidate>();
  const candidatesByAuthoredLane = new Map<string, BootstrapCandidate[]>();
  const candidatesByDisplayLane = new Map<number, BootstrapCandidate[]>();
  for (const candidate of candidates) {
    const authoredKey = `${candidate.trackKind}\u0000${candidate.authoredTrack}`;
    candidatesByAuthoredLane.set(authoredKey, [
      ...(candidatesByAuthoredLane.get(authoredKey) ?? []),
      candidate,
    ]);
    candidatesByDisplayLane.set(candidate.displayTrack, [
      ...(candidatesByDisplayLane.get(candidate.displayTrack) ?? []),
      candidate,
    ]);
  }
  for (const owners of candidatesByAuthoredLane.values()) {
    if (new Set(owners.map((owner) => owner.displayTrack)).size > 1) {
      owners.forEach((owner) => laneConflicts.add(owner));
    }
  }
  for (const owners of candidatesByDisplayLane.values()) {
    const nativeTracks = new Set(
      owners.map((owner) => `${owner.trackKind}\u0000${owner.authoredTrack}`),
    );
    if (nativeTracks.size > 1) owners.forEach((owner) => laneConflicts.add(owner));
  }
  for (const conflict of [...laneConflicts].sort((left, right) =>
    left.element.id.localeCompare(right.element.id),
  )) {
    diagnostics.push(
      diagnostic(
        "invalid-track",
        conflict.element,
        "Authored and display lane mappings must be one-to-one for each native track",
      ),
    );
  }
  const accepted = candidates.filter(
    (candidate) => !duplicates.has(candidate) && !laneConflicts.has(candidate),
  );

  const assetById = new Map<string, NativeProjectAsset>();
  const trackById = new Map<string, NativeProjectTrack>();
  for (const candidate of accepted) {
    const candidateAssetId = assetId(candidate.kind, candidate.source);
    const currentAsset = assetById.get(candidateAssetId);
    if (!currentAsset || currentAsset.durationFrames < candidate.sourceDurationFrames) {
      assetById.set(candidateAssetId, {
        id: candidateAssetId,
        kind: candidate.kind,
        name: sourceName(candidate.source),
        durationFrames: candidate.sourceDurationFrames,
      });
    }

    const candidateTrackId = trackId(candidate.authoredTrack, candidate.trackKind);
    const track = trackById.get(candidateTrackId) ?? {
      id: candidateTrackId,
      kind: candidate.trackKind,
      lane: {
        authoredTrack: candidate.authoredTrack,
        displayTrack: candidate.displayTrack,
      },
      clips: [],
    };
    const clip: NativeProjectClip = {
      id: clipId(candidate.binding),
      assetId: candidateAssetId,
      startFrame: candidate.startFrame,
      durationFrames: candidate.durationFrames,
      sourceInFrame: candidate.sourceInFrame,
      playbackRate: candidate.playbackRate,
      muted: candidate.element.muted ?? false,
      binding: candidate.binding,
      effects: [],
      parameterTracks: [],
    };
    track.clips.push(clip);
    trackById.set(candidateTrackId, track);
  }

  const assets = [...assetById.values()].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
  const tracks = [...trackById.values()]
    .map((track) => ({
      ...track,
      clips: [...track.clips].sort(
        (left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id),
      ),
    }))
    .sort((left, right) => {
      const leftTrack = left.lane?.authoredTrack ?? 0;
      const rightTrack = right.lane?.authoredTrack ?? 0;
      return leftTrack - rightTrack || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
    });

  const document = parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: input.projectId,
    revision: 0,
    frameRate: input.frameRate,
    canvas: input.canvas,
    assets,
    sequence: { id: input.sequenceId, name: input.sequenceName, tracks },
  });
  return { ok: true, document, diagnostics };
};
