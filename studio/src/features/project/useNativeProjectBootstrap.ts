import { useEffect, useMemo, useState } from "react";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";

import type { TimelineElement } from "../../player/store/timelineElement";
import { bootstrapNativeProjectFromTimeline } from "./nativeProjectBootstrap";
import {
  mergeLegacyGsapAnimationsIntoNativeProject,
  type LegacyGsapNativeBootstrapDiagnostic,
  type LegacyGsapNativeBootstrapSource,
} from "./legacyGsapNativeBootstrap";
import {
  buildLegacyGsapNativeSources,
  type LegacyGsapAnimationFile,
} from "./nativeProjectLegacySources";
import type { NativeProjectBootstrapDiagnostic } from "./nativeProjectBootstrap";
import type { NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import type { RationalFrameRate } from "../../../shared/project/nativeKeyframeTypes";
import type { NativeProjectSessionStatus } from "./useNativeProjectSession";

export interface NativeProjectBootstrapDimensions {
  readonly width: number;
  readonly height: number;
}

export interface UseNativeProjectBootstrapOptions {
  readonly status: NativeProjectSessionStatus;
  readonly projectId: string | null | undefined;
  readonly compositionDimensions: NativeProjectBootstrapDimensions | null;
  /** Authoritative project timebase; never inferred from preview wall-clock seconds. */
  readonly frameRate: RationalFrameRate | null;
  readonly timelineElements: readonly TimelineElement[];
  /**
   * File of the composition the timeline shows. Rows owned directly by it carry
   * no sourceFile of their own (only rows inside a sub-composition host do), the
   * same convention the timeline keys and DOM resolvers follow.
   */
  readonly activeSourceFile: string;
  readonly readLegacyAnimations: (
    projectId: string,
    sourceFile: string,
  ) => Promise<readonly GsapAnimation[] | null>;
}

export interface NativeProjectBootstrapState {
  readonly loading: boolean;
  readonly error?: string;
  readonly document: NativeProjectDocument | null;
  readonly diagnostics: readonly (
    | NativeProjectBootstrapDiagnostic
    | LegacyGsapNativeBootstrapDiagnostic
  )[];
}

const EMPTY_STATE: NativeProjectBootstrapState = {
  loading: false,
  document: null,
  diagnostics: [],
};

function sourceFilesOf(elements: readonly TimelineElement[]): string[] {
  return [...new Set(elements.map((element) => element.sourceFile).filter(Boolean) as string[])].sort();
}

function scopeToActiveFile(
  elements: readonly TimelineElement[],
  activeSourceFile: string,
): readonly TimelineElement[] {
  if (elements.every((element) => element.sourceFile)) return elements;
  return elements.map((element) =>
    element.sourceFile ? element : { ...element, sourceFile: activeSourceFile },
  );
}

function baseBootstrap(
  options: UseNativeProjectBootstrapOptions,
  timelineElements: readonly TimelineElement[],
): { document: NativeProjectDocument; diagnostics: readonly NativeProjectBootstrapDiagnostic[] } | null {
  if (
    options.status !== "absent" ||
    !options.projectId ||
    !options.compositionDimensions ||
    !options.frameRate ||
    timelineElements.length === 0
  ) {
    return null;
  }
  const result = bootstrapNativeProjectFromTimeline({
    projectId: options.projectId,
    sequenceId: "native-sequence:main",
    sequenceName: "Main",
    frameRate: options.frameRate,
    canvas: {
      width: Math.round(options.compositionDimensions.width),
      height: Math.round(options.compositionDimensions.height),
      background: "#000000",
    },
    elements: timelineElements,
  });
  if (!result.ok) return null;
  const clipCount = result.document.sequence.tracks.reduce(
    (count, track) => count + track.clips.length,
    0,
  );
  return clipCount > 0 ? result : null;
}

function unmatchedDiagnostic(
  unmatched: ReturnType<typeof buildLegacyGsapNativeSources>["unmatched"],
): LegacyGsapNativeBootstrapDiagnostic[] {
  return unmatched.map((entry) => ({
    animationId: entry.animation.id,
    reason: entry.reason === "dynamic-selector" ? "dynamic-selector" : "clip-not-found",
    disposition: "legacy-only" as const,
    message:
      entry.reason === "dynamic-selector"
        ? `Animation in ${entry.sourceFile} uses a dynamic selector and remains legacy-owned`
        : `Animation in ${entry.sourceFile} did not match an exact native clip binding`,
  }));
}

/**
 * Builds the ephemeral first-edit candidate only while no native sidecar is
 * authoritative. Legacy parsing is read-only and must finish before this
 * candidate is exposed to edit routing; this prevents an early native edit from
 * silently dropping representable GSAP animation data.
 */
export function useNativeProjectBootstrap(
  options: UseNativeProjectBootstrapOptions,
): NativeProjectBootstrapState {
  const timelineElements = useMemo(
    () => scopeToActiveFile(options.timelineElements, options.activeSourceFile),
    [options.activeSourceFile, options.timelineElements],
  );
  const base = useMemo(() => baseBootstrap(options, timelineElements), [
    options.compositionDimensions,
    options.frameRate,
    options.projectId,
    options.status,
    timelineElements,
  ]);
  const files = useMemo(() => sourceFilesOf(timelineElements), [timelineElements]);
  const [parsed, setParsed] = useState<{
    base: NonNullable<typeof base>;
    files: readonly LegacyGsapAnimationFile[];
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (!base || !options.projectId) {
      setParsed(null);
      return;
    }
    let cancelled = false;
    void Promise.all(
      files.map(async (sourceFile): Promise<LegacyGsapAnimationFile> => {
        const animations = await options.readLegacyAnimations(options.projectId!, sourceFile);
        if (animations === null) throw new Error(`Could not read animations from ${sourceFile}`);
        return { sourceFile, animations };
      }),
    )
      .then((next) => {
        if (cancelled) return;
        setParsed({ base, files: next });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setParsed({ base, files: [], error: error instanceof Error ? error.message : "Could not read the authored animations" });
      });
    return () => {
      cancelled = true;
    };
  }, [base, files, options.projectId, options.readLegacyAnimations]);

  return useMemo(() => {
    if (!base) return EMPTY_STATE;
    if (parsed?.base !== base) return { ...EMPTY_STATE, loading: true };
    if (parsed.error) return { ...EMPTY_STATE, error: parsed.error };
    const collected = buildLegacyGsapNativeSources(base.document, timelineElements, parsed.files);
    const merged = mergeLegacyGsapAnimationsIntoNativeProject({
      document: base.document,
      sources: collected.sources as readonly LegacyGsapNativeBootstrapSource[],
    });
    return {
      loading: false,
      document: merged.document,
      diagnostics: [
        ...base.diagnostics,
        ...merged.diagnostics,
        ...unmatchedDiagnostic(collected.unmatched),
      ],
    };
  }, [base, timelineElements, parsed]);
}
