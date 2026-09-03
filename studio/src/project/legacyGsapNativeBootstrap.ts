/**
 * Merge the exact, read-only GSAP import into an already bootstrapped native
 * project. This is intentionally a pure boundary: it does not write source,
 * touch the DOM, or make GSAP a native runtime dependency.
 */
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";

import {
  adaptLegacyGsapAnimations,
  type LegacyGsapImportReason,
} from "./legacyGsapKeyframeAdapter";
import type { NativeParameterTrack, RationalFrameRate } from "./nativeKeyframeTypes";
import {
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeClipDomBinding,
  type NativeProjectClip,
  type NativeProjectDocument,
} from "./nativeProjectDocument";

export type LegacyGsapNativeBootstrapReason =
  | LegacyGsapImportReason
  | "missing-clip-reference"
  | "clip-not-found"
  | "binding-mismatch"
  | "native-parameter-already-owned";

export interface LegacyGsapNativeBootstrapSource {
  /** Canonical native clip ID. Prefer binding when crossing the legacy boundary. */
  readonly clipId?: string;
  /** Exact legacy DOM binding from the native bootstrap document. */
  readonly binding?: NativeClipDomBinding;
  readonly animations: readonly GsapAnimation[];
}

export interface LegacyGsapNativeBootstrapDiagnostic {
  readonly clipId?: string;
  readonly animationId?: string;
  readonly parameterId?: string;
  readonly reason: LegacyGsapNativeBootstrapReason;
  readonly disposition: "legacy-only" | "ignored";
  readonly message: string;
}

export interface LegacyGsapNativeBootstrapInput {
  readonly document: NativeProjectDocument;
  readonly sources: readonly LegacyGsapNativeBootstrapSource[];
}

export interface LegacyGsapNativeBootstrapLegacyAnimation {
  readonly clipId: string;
  readonly animation: GsapAnimation;
}

export interface LegacyGsapNativeBootstrapResult {
  readonly document: NativeProjectDocument;
  readonly importedTrackIds: readonly string[];
  readonly legacyOnly: readonly LegacyGsapNativeBootstrapLegacyAnimation[];
  readonly diagnostics: readonly LegacyGsapNativeBootstrapDiagnostic[];
}

interface LocatedClip {
  readonly trackIndex: number;
  readonly clipIndex: number;
  readonly clip: NativeProjectClip;
}

const BINDING_KEYS: ReadonlyArray<keyof NativeClipDomBinding> = [
  "sourceFile",
  "domId",
  "hfId",
  "selector",
  "selectorIndex",
];

function bindingsEqual(
  left: NativeClipDomBinding | undefined,
  right: NativeClipDomBinding | undefined,
): boolean {
  if (!left || !right) return left === right;
  return BINDING_KEYS.every((key) => left[key] === right[key]);
}

function allClips(document: NativeProjectDocument): LocatedClip[] {
  return document.sequence.tracks.flatMap((track, trackIndex) =>
    track.clips.map((clip, clipIndex) => ({ trackIndex, clipIndex, clip })),
  );
}

function stableSourceKey(source: LegacyGsapNativeBootstrapSource, clipId: string): string {
  const animationKey = source.animations
    .map((animation) =>
      [
        animation.id,
        animation.method,
        animation.targetSelector,
        animation.resolvedStart,
        animation.position,
        animation.duration,
      ].join("\u0000"),
    )
    .sort()
    .join("\u0001");
  return `${clipId}\u0002${animationKey}`;
}

function locateSourceClip(
  document: NativeProjectDocument,
  source: LegacyGsapNativeBootstrapSource,
): LocatedClip | null {
  const clips = allClips(document);
  const byId = source.clipId ? clips.find(({ clip }) => clip.id === source.clipId) : null;
  const byBinding = source.binding
    ? clips.find(({ clip }) => bindingsEqual(clip.binding, source.binding))
    : null;
  if (
    source.clipId &&
    source.binding &&
    (!byId || !byBinding || byId.clip.id !== byBinding.clip.id)
  ) {
    return null;
  }
  return byId ?? byBinding ?? null;
}

function diagnostic(
  source: LegacyGsapNativeBootstrapSource,
  reason: LegacyGsapNativeBootstrapReason,
  message: string,
  animation?: GsapAnimation,
  clipId?: string,
  parameterId?: string,
): LegacyGsapNativeBootstrapDiagnostic {
  return {
    ...(clipId ? { clipId } : source.clipId ? { clipId: source.clipId } : {}),
    ...(animation ? { animationId: animation.id } : {}),
    ...(parameterId ? { parameterId } : {}),
    reason,
    disposition: "legacy-only",
    message,
  };
}

function clipStartSeconds(clip: NativeProjectClip, frameRate: RationalFrameRate): number {
  return (clip.startFrame * frameRate.denominator) / frameRate.numerator;
}

function sameTrack(left: NativeParameterTrack, right: NativeParameterTrack): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeIntoClip(
  clip: NativeProjectClip,
  imported: readonly NativeParameterTrack[],
  frameRate: RationalFrameRate,
): { clip: NativeProjectClip; importedTrackIds: string[]; conflicts: string[] } {
  const existingById = new Map(clip.parameterTracks.map((track) => [track.id, track]));
  const existingByParameter = new Map(
    clip.parameterTracks.map((track) => [track.parameterId, track]),
  );
  const conflicts: string[] = [];
  const additions: NativeParameterTrack[] = [];
  for (const track of imported) {
    const exact = existingById.get(track.id);
    if (exact) {
      if (!sameTrack(exact, track)) conflicts.push(track.parameterId);
      continue;
    }
    const owner = existingByParameter.get(track.parameterId);
    if (owner) {
      conflicts.push(track.parameterId);
      continue;
    }
    if (
      track.frameRate.numerator !== frameRate.numerator ||
      track.frameRate.denominator !== frameRate.denominator
    ) {
      conflicts.push(track.parameterId);
      continue;
    }
    additions.push(track);
  }
  if (conflicts.length > 0) {
    return { clip, importedTrackIds: [], conflicts: [...new Set(conflicts)].sort() };
  }
  return {
    clip:
      additions.length === 0
        ? clip
        : { ...clip, parameterTracks: [...clip.parameterTracks, ...additions] },
    importedTrackIds: additions.map((track) => track.id),
    conflicts: [],
  };
}

/**
 * Merge exact literal GSAP animations into native clip parameter tracks.
 *
 * A source is resolved by canonical clip ID or, preferably, its exact DOM
 * binding. Existing native owners are never replaced. Re-running this function
 * with the same input is a no-op because already-imported track IDs are treated
 * as the same ownership, while a different native owner remains a conflict.
 */
export function mergeLegacyGsapAnimationsIntoNativeProject(
  input: LegacyGsapNativeBootstrapInput,
): LegacyGsapNativeBootstrapResult {
  const diagnostics: LegacyGsapNativeBootstrapDiagnostic[] = [];
  const legacyOnly: LegacyGsapNativeBootstrapLegacyAnimation[] = [];
  const importedTrackIds: string[] = [];
  const located = input.sources
    .map((source) => ({ source, located: locateSourceClip(input.document, source) }))
    .sort((left, right) => {
      const leftId = left.located?.clip.id ?? left.source.clipId ?? "";
      const rightId = right.located?.clip.id ?? right.source.clipId ?? "";
      return (
        leftId.localeCompare(rightId) ||
        stableSourceKey(left.source, leftId).localeCompare(stableSourceKey(right.source, rightId))
      );
    });

  const duplicateIds = new Map<string, number>();
  for (const { source, located: match } of located) {
    if (!match) continue;
    for (const animation of source.animations) {
      const key = `${match.clip.id}\u0000${animation.id}`;
      duplicateIds.set(key, (duplicateIds.get(key) ?? 0) + 1);
    }
  }

  let document = parseNativeProjectDocument(JSON.parse(serializeNativeProjectDocument(input.document)));
  for (const { source, located: initialMatch } of located) {
    let matched = initialMatch;
    if (!source.clipId && !source.binding) {
      for (const animation of source.animations) {
        legacyOnly.push({ clipId: "", animation });
        diagnostics.push(
          diagnostic(source, "missing-clip-reference", "Source must provide a clip ID or exact binding", animation),
        );
      }
      continue;
    }
    if (!matched) {
      const reason = source.clipId && source.binding ? "binding-mismatch" : "clip-not-found";
      for (const animation of source.animations) {
        legacyOnly.push({ clipId: source.clipId ?? "", animation });
        diagnostics.push(
          diagnostic(source, reason, "Legacy animation source does not resolve to one native clip", animation),
        );
      }
      continue;
    }

    const clipId = matched.clip.id;
    const frameRate = input.document.frameRate;
    const startSeconds = clipStartSeconds(matched.clip, frameRate);
    const existingAnimationIds = new Set<string>();
    for (const animation of source.animations) {
      if (existingAnimationIds.has(animation.id) || (duplicateIds.get(`${clipId}\u0000${animation.id}`) ?? 0) > 1) {
        legacyOnly.push({ clipId, animation });
        diagnostics.push(
          diagnostic(source, "duplicate-animation-id", "Animation ID is not unique within this native clip", animation, clipId),
        );
        continue;
      }
      existingAnimationIds.add(animation.id);

      const adapted = adaptLegacyGsapAnimations({
        clipId,
        clipStartSeconds: startSeconds,
        frameRate,
        animations: [animation],
      });
      if (adapted.nativeTracks.length === 0) {
        legacyOnly.push({ clipId, animation });
        for (const issue of adapted.diagnostics) {
          diagnostics.push({ ...issue, clipId, disposition: "legacy-only" });
        }
        continue;
      }

      const currentMatch = matched;
      const merged = mergeIntoClip(currentMatch.clip, adapted.nativeTracks, frameRate);
      if (merged.conflicts.length > 0) {
        legacyOnly.push({ clipId, animation });
        for (const parameterId of merged.conflicts) {
          diagnostics.push(
            diagnostic(
              source,
              "native-parameter-already-owned",
              `Native parameter ${parameterId} is already owned and was not overwritten`,
              animation,
              clipId,
              parameterId,
            ),
          );
        }
        continue;
      }
      if (merged.importedTrackIds.length === 0) continue;
      importedTrackIds.push(...merged.importedTrackIds);
      document = parseNativeProjectDocument({
        ...document,
        sequence: {
          ...document.sequence,
            tracks: document.sequence.tracks.map((track, trackIndex) =>
            trackIndex !== currentMatch.trackIndex
              ? track
              : {
                  ...track,
                  clips: track.clips.map((clip, clipIndex) =>
                    clipIndex !== currentMatch.clipIndex
                      ? clip
                      : mergeIntoClip(clip, adapted.nativeTracks, frameRate).clip,
                  ),
                },
          ),
        },
      });
      // Keep the location reference current after rebuilding the immutable doc.
      matched = locateSourceClip(document, { clipId, animations: [] });
      if (!matched) throw new Error(`Native clip ${clipId} disappeared during GSAP merge`);
    }
  }

  return {
    document,
    importedTrackIds: [...new Set(importedTrackIds)].sort(),
    legacyOnly,
    diagnostics,
  };
}
