import { useEffect, useMemo, useRef, useState } from "react";

import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "../project/nativeProjectDocument";
import {
  installNativeProjectRuntime,
  type NativeProjectRuntimeClock,
} from "../project/nativeProjectRuntime";

export type NativeProjectSessionStatus = "idle" | "loading" | "absent" | "ready" | "error";

export interface NativeProjectSessionState {
  status: NativeProjectSessionStatus;
  document: NativeProjectDocument | null;
  error: Error | null;
}

export interface UseNativeProjectSessionOptions {
  projectId: string | null | undefined;
  readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  /** Bump after a native project save or external file-change notification. */
  reloadToken?: unknown;
  /** Re-render with a new iframe/document to reinstall into that preview only. */
  iframe: HTMLIFrameElement | null;
  clock?: NativeProjectRuntimeClock;
  /** Called only after a native adapter has installed successfully. */
  onNativeDuration?: (durationSeconds: number) => void;
  getPlaybackRate?: () => number;
}

const idleState: NativeProjectSessionState = { status: "idle", document: null, error: null };

function browserClock(): NativeProjectRuntimeClock {
  return {
    now: () => performance.now(),
    requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
  };
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
  const lastRequestedProjectId = useRef<string | null | undefined>(undefined);
  const clock = useMemo(() => options.clock ?? browserClock(), [options.clock]);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const abort = new AbortController();
    const projectChanged = lastRequestedProjectId.current !== options.projectId;
    lastRequestedProjectId.current = options.projectId;
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
        if (abort.signal.aborted || generation !== requestGeneration.current) return;
        if (content == null || content.trim().length === 0) {
          setState({ status: "absent", document: null, error: null });
          return;
        }
        const document = parseNativeProjectDocument(JSON.parse(content));
        if (abort.signal.aborted || generation !== requestGeneration.current) return;
        setState({ status: "ready", document, error: null });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted || generation !== requestGeneration.current) return;
        setState((previous) => ({
          status: "error",
          document: projectChanged ? null : previous.document,
          error: error instanceof Error ? error : new Error("Unable to load native project sidecar"),
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
  const iframeDocument = options.iframe?.contentDocument ?? null;
  useEffect(() => {
    if (!state.document || !iframeWindow || !iframeDocument) return;
    let runtime: ReturnType<typeof installNativeProjectRuntime> | null = null;
    try {
      runtime = installNativeProjectRuntime({
        window: iframeWindow,
        document: iframeDocument,
        project: state.document,
        clock,
        getPlaybackRate: options.getPlaybackRate,
      });
      options.onNativeDuration?.(
        (runtime.durationFrames * state.document.frameRate.denominator) /
          state.document.frameRate.numerator,
      );
    } catch (error) {
      setState((previous) =>
        previous.document === state.document
          ? {
              status: "error",
              document: null,
              error: error instanceof Error ? error : new Error("Unable to install native playback"),
            }
          : previous,
      );
    }
    return () => runtime?.cleanup();
  }, [
    clock,
    iframeDocument,
    iframeDocumentVersion,
    iframeWindow,
    options.getPlaybackRate,
    options.onNativeDuration,
    state.document,
  ]);

  return state;
}
