import { useEffect, useMemo, useRef, useState } from "react";

import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import {
  installNativeProjectRuntime,
  type NativeProjectRuntimeClock,
} from "./nativeProjectRuntime";
import {
  discardCommittedNativeGestureDrafts,
  releaseCommittedNativeGestureDrafts,
} from "./nativeGestureDraft";
import { attachPreviewAgent } from "../preview/previewAgentClient";
import { previewOriginFromIframe } from "../../player/lib/previewUrl";
import { previewOriginForProject } from "../../../shared/desktopPreviewOrigin";
import { bakeTrackSamples, vkfEngine } from "../../../shared/engine/vkfEngine";
import type { PreviewBakedTrack } from "../../../shared/preview/agentProtocol";

export type NativeProjectSessionStatus =
  "idle" | "loading" | "absent" | "ready" | "error";

export interface NativeProjectSessionState {
  status: NativeProjectSessionStatus;
  document: NativeProjectDocument | null;
  error: Error | null;
}

export interface UseNativeProjectSessionOptions {
  projectId: string | null | undefined;
  activeSourceFile?: string;
  readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  /** Bump after a native project save or external file-change notification. */
  reloadToken?: unknown;
  /** Re-render with a new iframe/document to reinstall into that preview only. */
  iframe: HTMLIFrameElement | null;
  clock?: NativeProjectRuntimeClock;
  /** Called only after a native adapter has installed successfully. */
  onNativeDuration?: (durationSeconds: number) => void;
  getPlaybackRate?: () => number;
  /** Editor playhead may hydrate before the native sidecar/iframe arrives. */
  getPlayheadSeconds?: () => number;
  /** A Play click can reach the legacy adapter before native installation. */
  getIsPlaying?: () => boolean;
}

const idleState: NativeProjectSessionState = {
  status: "idle",
  document: null,
  error: null,
};

function browserClock(): NativeProjectRuntimeClock {
  return {
    now: () => performance.now(),
    requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
  };
}

function accessiblePreviewDocument(iframe: HTMLIFrameElement | null): Document | null {
  try { return iframe?.contentDocument ?? null; }
  catch { return null; }
}

function isCurrentIsolatedPreview(iframe: HTMLIFrameElement | null, projectId: string | null | undefined): boolean {
  if (!iframe || !projectId || accessiblePreviewDocument(iframe)) return false;
  try {
    const url = new URL(iframe.src);
    const prefix = `/api/projects/${encodeURIComponent(projectId)}/preview`;
    return previewOriginFromIframe(iframe) === previewOriginForProject(projectId)
      && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
  } catch { return false; }
}

function nativeProjectDurationSeconds(project: NativeProjectDocument): number {
  let frames = Math.max(0, project.sequence.durationFrames ?? 0);
  for (const track of project.sequence.tracks) {
    for (const clip of track.clips) frames = Math.max(frames, clip.startFrame + clip.durationFrames);
  }
  return frames * project.frameRate.denominator / project.frameRate.numerator;
}

/** The isolated document has no preload bridge; sample with the editor's C++ engine. */
export function bakeIsolatedPreviewTracks(project: NativeProjectDocument): PreviewBakedTrack[] {
  const baked: PreviewBakedTrack[] = [];
  let sampleCount = 0;
  for (const track of project.sequence.tracks) for (const clip of track.clips) {
    const bake = (
      tracks: typeof clip.parameterTracks,
      durationFrames: number,
      referenceIndex?: number,
    ) => {
      for (const parameterTrack of tracks) {
      if (baked.length >= 512) throw new Error("Preview has too many animated tracks");
      const lastFrame = parameterTrack.keyframes.reduce((max, key) => Math.max(max, key.frame), 0);
      const frameCount = Math.max(1, durationFrames, lastFrame + 1);
      const components = parameterTrack.valueType === "number" ? 1 : parameterTrack.valueType === "vec2" ? 2 : 4;
      const count = frameCount * (components + (parameterTrack.valueType === "vec2" ? 1 : 0));
      sampleCount += count;
      if (sampleCount > 4_000_000 || frameCount * components > 1_000_000) {
        throw new Error("Preview animation exceeds the supported sample limit");
      }
      baked.push({
        clipId: clip.id,
        trackId: parameterTrack.id,
        ...(referenceIndex === undefined ? {} : { referenceIndex }),
        ...bakeTrackSamples(vkfEngine(), parameterTrack, durationFrames),
      });
      }
    };
    bake(clip.parameterTracks, clip.durationFrames);
    for (const [index, segment] of (clip.cropPivotSegments ?? []).entries()) {
      if (segment.reference) bake(segment.reference.parameterTracks, segment.reference.durationFrames, index);
    }
  }
  return baked;
}

/**
 * Optionally loads the native sidecar. Absent/malformed files never take over
 * preview playback; only a successfully parsed document can install an adapter.
 */
export function useNativeProjectSession(
  options: UseNativeProjectSessionOptions,
): NativeProjectSessionState {
  const [state, setState] = useState<NativeProjectSessionState>(idleState);
  const [iframeDocumentVersion, setIframeDocumentVersion] = useState(0);
  const requestGeneration = useRef(0);
  const documentOwners = useRef(new WeakMap<NativeProjectDocument, string>());
  const lastRequestedProjectId = useRef<string | null | undefined>(undefined);
  const transportSnapshot = useRef<{
    projectId: string;
    time: number;
    playing: boolean;
  } | null>(null);
  const clock = useMemo(() => options.clock ?? browserClock(), [options.clock]);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const abort = new AbortController();
    const projectChanged = lastRequestedProjectId.current !== options.projectId;
    lastRequestedProjectId.current = options.projectId;
    const activeDocument = accessiblePreviewDocument(options.iframe);
    if (projectChanged && activeDocument) {
      discardCommittedNativeGestureDrafts(activeDocument);
    }
    if (!options.projectId) {
      setState(idleState);
      return () => abort.abort();
    }
    // A refresh of the same project is deliberately non-destructive: the last
    // known-good adapter continues to render until the replacement has parsed.
    // A project boundary is different — never let project A appear in project B.
    setState((previous) => ({
      status: "loading",
      document: projectChanged ? null : previous.document,
      error: null,
    }));
    void options
      .readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH)
      .then((content) => {
        if (abort.signal.aborted || generation !== requestGeneration.current)
          return;
        if (content == null || content.trim().length === 0) {
          setState({ status: "absent", document: null, error: null });
          return;
        }
        const document = parseNativeProjectDocument(JSON.parse(content));
        if (abort.signal.aborted || generation !== requestGeneration.current)
          return;
        documentOwners.current.set(document, options.projectId!);
        setState({ status: "ready", document, error: null });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted || generation !== requestGeneration.current)
          return;
        setState((previous) => ({
          status: "error",
          document: projectChanged ? null : previous.document,
          error:
            error instanceof Error
              ? error
              : new Error("Unable to load native project sidecar"),
        }));
      });
    return () => abort.abort();
  }, [options.projectId, options.readOptionalProjectFile, options.reloadToken]);

  // A soft preview refresh navigates the existing iframe element. React sees
  // the same object identity, so reading contentDocument only during render
  // otherwise leaves the native runtime attached to the document that was
  // just discarded. Treat each load as a new preview-document generation.
  useEffect(() => {
    const iframe = options.iframe;
    if (!iframe || typeof iframe.addEventListener !== "function") return;
    const handleLoad = () => setIframeDocumentVersion((version) => version + 1);
    iframe.addEventListener("load", handleLoad);
    return () => iframe.removeEventListener?.("load", handleLoad);
  }, [options.iframe]);

  const iframeWindow = options.iframe?.contentWindow ?? null;
  const iframeDocument = accessiblePreviewDocument(options.iframe);
  const isolatedPreview = isCurrentIsolatedPreview(options.iframe, options.projectId);
  useEffect(() => {
    const nativeDocument = state.document;
    const iframe = options.iframe;
    if (!isolatedPreview || !iframe || !nativeDocument ||
      documentOwners.current.get(nativeDocument) !== options.projectId) return;
    const client = attachPreviewAgent(iframe);
    let cancelled = false;
    const install = () => {
      if (cancelled || !isCurrentIsolatedPreview(iframe, options.projectId)) return;
      let bakedTracks: PreviewBakedTrack[];
      try { bakedTracks = bakeIsolatedPreviewTracks(nativeDocument); }
      catch (error) {
        setState(previous => previous.document === nativeDocument
          ? { ...previous, status: "error", error: error instanceof Error ? error : new Error(String(error)) }
          : previous);
        return;
      }
      void client.request({
        kind: "installNativeProject",
        project: nativeDocument,
        bakedTracks,
        activeSourceFile: options.activeSourceFile ?? "index.html",
        timeSeconds: Math.max(0, options.getPlayheadSeconds?.() ?? 0),
        playing: options.getIsPlaying?.() ?? false,
      }).then(() => {
        if (!cancelled) options.onNativeDuration?.(nativeProjectDurationSeconds(nativeDocument));
      }).catch(error => {
        if (cancelled || !client.isReady) return;
        setState(previous => previous.document === nativeDocument
          ? { ...previous, status: "error", error: error instanceof Error ? error : new Error(String(error)) }
          : previous);
      });
    };
    const unsubscribe = client.onReady(install);
    return () => { cancelled = true; unsubscribe(); };
  }, [
    iframeDocumentVersion,
    isolatedPreview,
    options.activeSourceFile,
    options.getIsPlaying,
    options.getPlayheadSeconds,
    options.iframe,
    options.onNativeDuration,
    options.projectId,
    state.document,
  ]);
  useEffect(() => {
    const nativeDocument = state.document;
    if (isolatedPreview || !nativeDocument || documentOwners.current.get(nativeDocument) !== options.projectId || !iframeWindow || !iframeDocument) return;
    let runtime: ReturnType<typeof installNativeProjectRuntime> | null = null;
    try {
      runtime = installNativeProjectRuntime({
        window: iframeWindow,
        document: iframeDocument,
        project: nativeDocument,
        activeSourceFile: options.activeSourceFile,
        onBindingError: error => setState(previous => previous.document === nativeDocument ? { ...previous, status: "error", error } : previous),
        clock,
        getPlaybackRate: options.getPlaybackRate,
      });
      // Effect cleanup runs before replacement installation, so the previous
      // native adapter is no longer discoverable on the iframe window. Restore
      // its transport explicitly instead of silently starting each save at zero.
      const saved = transportSnapshot.current;
      if (saved?.projectId === nativeDocument.id) {
        runtime.player.seek(saved.time);
        if (saved.playing) runtime.player.play();
      } else {
        if (options.getPlayheadSeconds) runtime.player.seek(options.getPlayheadSeconds());
        // On first installation there is no native transport to snapshot yet.
        // Preserve an early Play click already accepted by the editor/legacy
        // adapter instead of replacing it with a paused native transport.
        if (options.getIsPlaying?.()) runtime.player.play();
      }
      // The save promise can resolve before this async sidecar reload installs.
      // Retire the committed picture only once the replacement has successfully
      // painted. Reapply synchronously after retiring it, before the browser can
      // show another frame or a newer gesture loses its own draft.
      releaseCommittedNativeGestureDrafts(iframeDocument, nativeDocument.id, nativeDocument.revision);
      runtime.player.seek(runtime.player.getTime(), {
        keepPlaying: runtime.player.isPlaying(),
      });
      options.onNativeDuration?.(
        (runtime.durationFrames * nativeDocument.frameRate.denominator) /
          nativeDocument.frameRate.numerator,
      );
    } catch (error) {
      setState((previous) =>
        previous.document === state.document
          ? {
              status: "error",
              document: null,
              error:
                error instanceof Error
                  ? error
                  : new Error("Unable to install native playback"),
            }
          : previous,
      );
    }
    return () => {
      if (!runtime) return;
      transportSnapshot.current = {
        projectId: nativeDocument.id,
        time: runtime.player.getTime(),
        playing: runtime.player.isPlaying?.() ?? false,
      };
      runtime.cleanup();
    };
  }, [
    clock,
    iframeDocument,
    iframeDocumentVersion,
    iframeWindow,
    isolatedPreview,
    options.getPlaybackRate,
    options.getPlayheadSeconds,
    options.getIsPlaying,
    options.onNativeDuration,
    options.activeSourceFile,
    options.projectId,
    state.document,
  ]);

  return state;
}
