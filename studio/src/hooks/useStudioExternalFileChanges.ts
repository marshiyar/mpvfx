import { useCallback, type MutableRefObject } from "react";
import {
  deleteExternalConflictSnapshot,
  loadExternalConflictSnapshot,
  persistExternalConflictSnapshot,
  persistExternalFailureSnapshot,
} from "../utils/externalConflictStorage";
import { notifyExternalFileReload } from "./externalFileReloadBus";
import { useExternalFileChangeCoordinator } from "./useExternalFileChangeCoordinator";
import type { useFileManager } from "./useFileManager";
import type { usePreviewPersistence } from "./usePreviewPersistence";

type FileManager = Pick<
  ReturnType<typeof useFileManager>,
  | "editingFile"
  | "overwriteExternalConflict"
  | "readProjectFile"
  | "updateEditingFileContent"
>;

type PreviewPersistence = Pick<
  ReturnType<typeof usePreviewPersistence>,
  "drainPendingDomEditSaves" | "resetDomEditSaveQueueBreaker"
>;

interface UseStudioExternalFileChangesOptions {
  projectId: string | null;
  activeCompPath: string | null;
  masterCompPath: string | null;
  fileManager: FileManager;
  previewPersistence: PreviewPersistence;
  pendingTimelineEditPathRef: MutableRefObject<Set<string>>;
  reloadPreview: () => void;
}

/** Connects the app's save queues, recovery storage, and reload surfaces to one owner. */
export function useStudioExternalFileChanges({
  projectId,
  activeCompPath,
  masterCompPath,
  fileManager,
  previewPersistence,
  pendingTimelineEditPathRef,
  reloadPreview,
}: UseStudioExternalFileChangesOptions) {
  const { drainPendingDomEditSaves, resetDomEditSaveQueueBreaker } = previewPersistence;
  const drainPendingChanges = useCallback(
    () => drainPendingDomEditSaves(),
    [drainPendingDomEditSaves],
  );

  const discardPendingChanges = useCallback(() => {
    resetDomEditSaveQueueBreaker();
  }, [resetDomEditSaveQueueBreaker]);

  return useExternalFileChangeCoordinator({
    projectId,
    activeCompPath,
    recoveryFilePath: fileManager.editingFile?.path ?? activeCompPath ?? masterCompPath,
    pendingTimelineEditPathRef,
    drainPendingChanges,
    discardPendingChanges,
    reloadPreview,
    reloadSdkSession: notifyExternalFileReload,
    persistConflictSnapshot: persistExternalConflictSnapshot,
    persistFailureSnapshot: persistExternalFailureSnapshot,
    loadConflictSnapshot: loadExternalConflictSnapshot,
    deleteConflictSnapshot: deleteExternalConflictSnapshot,
    overwriteConflict: fileManager.overwriteExternalConflict,
    readProjectFile: fileManager.readProjectFile,
    onUseExternalFile: fileManager.updateEditingFileContent,
    resetSaveQueues: resetDomEditSaveQueueBreaker,
  });
}
