import { useEffect, useMemo, useState } from "react";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";

import type { TimelineElement } from "../player/store/timelineElement";
import { bootstrapNativeProjectFromTimeline } from "../project/nativeProjectBootstrap";
import {
  mergeLegacyGsapAnimationsIntoNativeProject,
  type LegacyGsapNativeBootstrapDiagnostic,
  type LegacyGsapNativeBootstrapSource,
} from "../project/legacyGsapNativeBootstrap";
import {
  buildLegacyGsapNativeSources,
  type LegacyGsapAnimationFile,
} from "../project/nativeProjectLegacySources";
import type { NativeProjectBootstrapDiagnostic } from "../project/nativeProjectBootstrap";
import type { NativeProjectDocument } from "../project/nativeProjectDocument";
import type { RationalFrameRate } from "../project/nativeKeyframeTypes";
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
  readonly readLegacyAnimations: (
    projectId: string,
    sourceFile: string,
  ) => Promise<readonly GsapAnimation[] | null>;
}

export interface NativeProjectBootstrapState {
  readonly loading: boolean;
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

function baseBootstrap(
  options: UseNativeProjectBootstrapOptions,
): { document: NativeProjectDocument; diagnostics: readonly NativeProjectBootstrapDiagnostic[] } | null {
  if (
    options.status !== "absent" ||
    !options.projectId ||
    !options.compositionDimensions ||
    !options.frameRate ||
    options.timelineElements.length === 0
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
    elements: options.timelineElements,
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
  const base = useMemo(() => baseBootstrap(options), [
    options.compositionDimensions,
    options.frameRate,
    options.projectId,
    options.status,
    options.timelineElements,
  ]);
  const files = useMemo(() => sourceFilesOf(options.timelineElements), [options.timelineElements]);
  const [parsedFiles, setParsedFiles] = useState<readonly LegacyGsapAnimationFile[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!base || !options.projectId) {
      setParsedFiles([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void Promise.all(
      files.map(async (sourceFile): Promise<LegacyGsapAnimationFile> => ({
        sourceFile,
        animations: (await options.readLegacyAnimations(options.projectId!, sourceFile)) ?? [],
      })),
    )
      .then((next) => {
        if (cancelled) return;
        setParsedFiles(next);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setParsedFiles([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [base, files, options.projectId, options.readLegacyAnimations]);

  return useMemo(() => {
    if (!base || loading) return { ...EMPTY_STATE, loading };
    const collected = buildLegacyGsapNativeSources(base.document, options.timelineElements, parsedFiles);
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
  }, [base, loading, options.timelineElements, parsedFiles]);
}
