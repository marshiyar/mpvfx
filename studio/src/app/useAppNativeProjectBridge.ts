import { useCallback, useEffect, useMemo, useState } from "react";
import type { RationalFrameRate } from "../../shared/project/nativeKeyframeTypes";
import type { TimelineElement } from "../player/index";
import { usePlayerStore } from "../player/index";
import { fetchParsedAnimations } from "../features/animation/Keyframe/keyframeCacheAstLoad";
import { useNativeProjectSession } from "../features/project/useNativeProjectSession";
import { useNativeProjectBootstrap, type NativeProjectBootstrapDimensions } from "../features/project/useNativeProjectBootstrap";
import type { NativeProjectHistoryEntry } from "../features/project/nativeProjectPersistence";
import type { useFileManager } from "../features/history/useFileManager";
import type { usePersistentEditHistory } from "../features/history/usePersistentEditHistory";
import type { useDurableStudioFileTransactions } from "../features/history/useDurableStudioFileTransactions";

interface AppNativeProjectOptions {
  projectId: string | null;
  activeCompPath: string | null;
  previewIframe: HTMLIFrameElement | null;
  refreshKey: number;
  compositionDimensions: NativeProjectBootstrapDimensions | null;
  timelineFrameRate: RationalFrameRate | null;
  timelineElements: readonly TimelineElement[];
  fileManager: Pick<ReturnType<typeof useFileManager>, "readExistingProjectFile" | "writeProjectFile">;
  editHistory: Pick<ReturnType<typeof usePersistentEditHistory>, "recordEdit">;
  commitNativeFileTransaction: ReturnType<typeof useDurableStudioFileTransactions>;
  showToast: (message: string, tone?: "error" | "info") => void;
}

/** Owns native sidecar loading, legacy bootstrap, and the durable editor bridge. */
export function useAppNativeProjectBridge({
  projectId,
  activeCompPath,
  previewIframe,
  refreshKey,
  compositionDimensions,
  timelineFrameRate,
  timelineElements,
  fileManager,
  editHistory,
  commitNativeFileTransaction,
  showToast,
}: AppNativeProjectOptions) {
  const [nativeProjectReloadToken, setNativeProjectReloadToken] = useState(0);
  const handleNativeDuration = useCallback((durationSeconds: number) => {
    usePlayerStore.getState().setDuration(durationSeconds);
  }, []);
  const getNativePlaybackRate = useCallback(
    () => usePlayerStore.getState().playbackRate,
    [],
  );
  const getNativePlayheadSeconds = useCallback(
    () => usePlayerStore.getState().currentTime,
    [],
  );
  const getNativeIsPlaying = useCallback(
    () => usePlayerStore.getState().isPlaying,
    [],
  );
  const nativeProjectSession = useNativeProjectSession({
    projectId,
    activeSourceFile: activeCompPath ?? "index.html",
    readOptionalProjectFile: fileManager.readExistingProjectFile,
    iframe: previewIframe,
    reloadToken: `${refreshKey}:${nativeProjectReloadToken}`,
    onNativeDuration: handleNativeDuration,
    getPlaybackRate: getNativePlaybackRate,
    getPlayheadSeconds: getNativePlayheadSeconds,
    getIsPlaying: getNativeIsPlaying,
  });
  const readLegacyAnimations = useCallback(
    async (legacyProjectId: string, sourceFile: string) =>
      (await fetchParsedAnimations(legacyProjectId, sourceFile))?.animations ?? null,
    [],
  );
  const nativeBootstrapState = useNativeProjectBootstrap({
    status: nativeProjectSession.status,
    projectId,
    compositionDimensions,
    frameRate: timelineFrameRate,
    timelineElements,
    activeSourceFile: activeCompPath ?? "index.html",
    readLegacyAnimations,
  });
  const nativeBootstrapDocument = nativeBootstrapState.document;
  useEffect(() => {
    if (nativeProjectSession.status !== "error" || !nativeProjectSession.error) return;
    showToast(`Native project could not be loaded: ${nativeProjectSession.error.message}`, "error");
  }, [nativeProjectSession.error, nativeProjectSession.status, showToast]);
  const recordNativeProjectHistory = useCallback(
    async (entry: NativeProjectHistoryEntry) => {
      await editHistory.recordEdit({
        label: entry.label,
        kind: "motion",
        files: {
          [entry.path]: { before: entry.before ?? "", after: entry.after },
        },
      });
    },
    [editHistory.recordEdit],
  );
  const handleNativeDocumentCommitted = useCallback(() => {
    setNativeProjectReloadToken((token) => token + 1);
  }, []);
  const nativeProjectEditing = useMemo(
    () => ({
      nativeDocument: nativeProjectSession.document,
      nativeBootstrapDocument,
      readOptionalProjectFile: fileManager.readExistingProjectFile,
      writeProjectFile: fileManager.writeProjectFile,
      recordHistory: recordNativeProjectHistory,
      onNativeDocumentCommitted: handleNativeDocumentCommitted,
      commitFileTransaction: commitNativeFileTransaction,
      getPlayheadSeconds: getNativePlayheadSeconds,
    }),
    [
      fileManager.readExistingProjectFile,
      fileManager.writeProjectFile,
      commitNativeFileTransaction,
      getNativePlayheadSeconds,
      handleNativeDocumentCommitted,
      nativeProjectSession.document,
      nativeBootstrapDocument,
      recordNativeProjectHistory,
    ],
  );
  return { nativeProjectEditing, reloadNativeProject: handleNativeDocumentCommitted };
}
