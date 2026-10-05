import { useCallback, useRef, type MutableRefObject } from "react";
import type { TimelineElement } from "../../player/index";
import { usePlayerStore } from "../../player/index";
import { trackStudioRazorSplit } from "../../telemetry/events";
import { canSplitElement, canSplitElementAt } from "./timelineElementSplit";
import { buildAtomicCutIntents, runAtomicCutTransaction } from "./razorSplitTransaction";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import {
  projectFrameFromSeconds,
  resolveNativeClipSelection,
} from "../../../shared/project/nativePropertyEditPlan";
import {
  commitNativeTimelineSplits,
  type NativeTimelineSplitCompatibilityEdit,
} from "../project/nativeTimelineSplitTransaction";
import { NativeProjectRevisionConflictError } from "../project/nativeProjectPersistence";
import { synchronizeIncomingNativeDocument } from "../project/nativeDocumentRefSync";
import type { RecordEditInput } from "./timelineEditingHelpers";
import { patchNativeTimelineSplitCompatibility } from "./nativeTimelineSplitCompatibility";
import type { NativeTimelineEditingDependencies } from "./useTimelineEditingTypes";

interface UseRazorSplitOptions {
  projectId: string | null;
  // fallow-ignore-next-line code-duplication
  activeCompPath: string | null;
  showToast: (message: string, tone?: "error" | "info") => void;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  observeProjectFileVersion?: (path: string, version: string | null) => void;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  domEditSaveTimestampRef: React.MutableRefObject<number>;
  reloadPreview: () => void;
  forceReloadSdkSession?: () => void;
  isRecordingRef?: React.RefObject<boolean>;
  nativeProjectEditing?: NativeTimelineEditingDependencies;
  nativeDocumentRef?: MutableRefObject<NativeProjectDocument | null>;
  editQueueRef?: MutableRefObject<Promise<unknown>>;
}

const nativeSelectionForElement = (element: TimelineElement) => ({
  id: element.id,
  hfId: element.hfId,
  sourceFile: element.sourceFile,
  selector: element.selector,
  selectorIndex: element.selectorIndex,
  expandedParentStart: element.expandedParentStart,
  expandedHostKey: element.expandedHostKey,
  parentCompositionId: element.parentCompositionId,
});

/**
 * Return null when an element is not native, otherwise apply the same exact
 * project-frame boundary checks as the native transaction.
 */
const canSplitNativeElementAt = (
  document: NativeProjectDocument | null,
  element: TimelineElement,
  splitTime: number,
): boolean | null => {
  if (!document) return null;
  const resolution = resolveNativeClipSelection(document, nativeSelectionForElement(element));
  if (!resolution.ok) return null;
  if (
    element.expandedParentStart !== undefined ||
    element.expandedHostKey ||
    element.parentCompositionId
  ) {
    return false;
  }

  let splitFrame: number;
  try {
    splitFrame = projectFrameFromSeconds(splitTime, document.frameRate);
  } catch {
    return false;
  }
  const clip = resolution.located.clip;
  const localFrame = splitFrame - clip.startFrame;
  return (
    Number.isSafeInteger(splitFrame) &&
    localFrame > 0 &&
    localFrame < clip.durationFrames
  );
};

export function useRazorSplit({
  projectId,
  activeCompPath,
  showToast,
  writeProjectFile,
  observeProjectFileVersion,
  recordEdit,
  domEditSaveTimestampRef,
  reloadPreview,
  forceReloadSdkSession,
  isRecordingRef,
  nativeProjectEditing,
  nativeDocumentRef: suppliedNativeDocumentRef,
  editQueueRef: suppliedEditQueueRef,
}: UseRazorSplitOptions) {
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const localNativeDocumentRef = useRef(nativeProjectEditing?.nativeDocument ?? null);
  const incomingNativeDocumentRef = useRef(nativeProjectEditing?.nativeDocument ?? null);
  const nativeDocumentRef = suppliedNativeDocumentRef ?? localNativeDocumentRef;
  const localEditQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const editQueueRef = suppliedEditQueueRef ?? localEditQueueRef;
  synchronizeIncomingNativeDocument(
    incomingNativeDocumentRef,
    nativeDocumentRef,
    nativeProjectEditing?.nativeDocument ?? null,
  );

  const synchronize = useCallback(() => {
    let failure: unknown;
    try {
      forceReloadSdkSession?.();
    } catch (error) {
      failure = error;
    }
    try {
      reloadPreview();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }, [forceReloadSdkSession, reloadPreview]);

  const runNativeCut = useCallback(
    async (elements: readonly TimelineElement[], splitTime: number) => {
      const dependencies = nativeProjectEditing;
      const initialDocument = nativeDocumentRef.current;
      if (!dependencies || !initialDocument) return null;

      const resolutions = elements.map((element) =>
        resolveNativeClipSelection(initialDocument, nativeSelectionForElement(element)),
      );
      const nativeCount = resolutions.filter((resolution) => resolution.ok).length;
      if (nativeCount === 0) return null;
      if (nativeCount !== elements.length) {
        throw new Error(
          "Cannot split a mixed native and legacy selection in one operation",
        );
      }

      const operation = editQueueRef.current.then(async () => {
        const commitAgainst = async (document: NativeProjectDocument) => {
          const clips = elements.map((element) => {
            const resolution = resolveNativeClipSelection(
              document,
              nativeSelectionForElement(element),
            );
            if (!resolution.ok) throw new Error(resolution.failure.message);
            return resolution.located.clip;
          });

          return commitNativeTimelineSplits({
            expectedRevision: document.revision,
            splits: elements.map((element) => ({
              element: nativeSelectionForElement(element),
              requestedSplitSeconds: splitTime,
            })),
            readOptionalProjectFile: dependencies.readOptionalProjectFile,
            writeProjectFile,
            recordEdit,
            commitFileTransaction: dependencies.commitFileTransaction,
            patchCompatibilityContent: (
              content: string,
              edit: NativeTimelineSplitCompatibilityEdit,
            ) => patchNativeTimelineSplitCompatibility(
              content, edit, clips[edit.requestIndex]!, document, elements[edit.requestIndex]!,
            ),
            onCommitted: (committed) => {
              nativeDocumentRef.current = committed;
              dependencies.onNativeDocumentCommitted(committed);
            },
          });
        };

        let result;
        try {
          result = await commitAgainst(nativeDocumentRef.current ?? initialDocument);
        } catch (error) {
          if (!(error instanceof NativeProjectRevisionConflictError)) throw error;
          const latestContent = await dependencies.readOptionalProjectFile(
            NATIVE_PROJECT_DOCUMENT_PATH,
          );
          if (!latestContent) throw error;
          const latest = parseNativeProjectDocument(JSON.parse(latestContent));
          nativeDocumentRef.current = latest;
          result = await commitAgainst(latest);
        }
        if (!result.committed) {
          throw new Error(`Native timeline split was rejected: ${result.reason}`);
        }

        domEditSaveTimestampRef.current = Date.now();
        let syncFailed = false;
        try {
          synchronize();
        } catch {
          syncFailed = true;
        }
        return {
          splitCount: result.splits.length,
          skippedSelectors: [] as string[],
          syncFailed,
        };
      });
      editQueueRef.current = operation.catch(() => undefined);
      return operation;
    },
    [
      domEditSaveTimestampRef,
      editQueueRef,
      nativeDocumentRef,
      nativeProjectEditing,
      recordEdit,
      synchronize,
      writeProjectFile,
    ],
  );

  const runCut = useCallback(
    async (elements: readonly TimelineElement[], splitTime: number, mode: "single" | "all") => {
      const pid = projectIdRef.current;
      if (!pid || elements.length === 0) return;
      const nativeResult = await runNativeCut(elements, splitTime);
      if (nativeResult) {
        trackStudioRazorSplit({ mode, count: nativeResult.splitCount });
        return nativeResult;
      }
      const intents = buildAtomicCutIntents(elements, splitTime, activeCompPath);
      const requestedCount = intents.reduce((count, file) => count + file.targets.length, 0);
      const label =
        mode === "single"
          ? "Split timeline clip"
          : `Split ${requestedCount} clips at ${splitTime.toFixed(2)}s`;

      // Server writes arrive through the watcher before React can refresh. Keep
      // the existing short self-write window active for this owned transaction.
      domEditSaveTimestampRef.current = Date.now();
      const result = await runAtomicCutTransaction({
        projectId: pid,
        intents,
        label,
        writeProjectFile,
        recordEdit,
        observeProjectFileVersion,
        synchronize,
      });
      trackStudioRazorSplit({ mode, count: result.splitCount });
      if (result.syncFailed) {
        showToast(
          "Cut was saved, but Studio could not refresh it. Reload the preview to resynchronize.",
          "error",
        );
      }
      if (result.skippedSelectors.length > 0) {
        showToast(
          `Some animations use non-ID selectors (${result.skippedSelectors.join(", ")}) and were not retargeted`,
          "info",
        );
      }
      return result;
    },
    [
      activeCompPath,
      domEditSaveTimestampRef,
      observeProjectFileVersion,
      recordEdit,
      showToast,
      synchronize,
      writeProjectFile,
      runNativeCut,
    ],
  );

  const handleRazorSplit = useCallback(
    async (element: TimelineElement, splitTime: number) => {
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return;
      }
      if (!canSplitElement(element)) return;
      const nativeValidity = canSplitNativeElementAt(
        nativeDocumentRef.current,
        element,
        splitTime,
      );
      if (nativeValidity === false) return;
      if (nativeValidity === null && !canSplitElementAt(element, splitTime)) return;
      try {
        const result = await runCut([element], splitTime, "single");
        if (!result) return;
        if (result.syncFailed) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to split timeline clip";
        showToast(message, "error");
      }
    },
    [isRecordingRef, nativeDocumentRef, runCut, showToast],
  );

  const splitForSilence = useCallback(async (element: TimelineElement, splitTime: number) => {
    if (isRecordingRef?.current) throw new Error("Cannot edit timeline while recording");
    if (!canSplitElement(element)) throw new Error("The selected video can no longer be split");
    const nativeValidity = canSplitNativeElementAt(nativeDocumentRef.current, element, splitTime);
    if (!(nativeValidity ?? canSplitElementAt(element, splitTime))) {
      throw new Error("The silence boundary is too close to a clip edge");
    }
    const result = await runCut([element], splitTime, "single");
    if (!result || result.syncFailed) throw new Error("Clip split did not synchronize with the timeline");
  }, [isRecordingRef, nativeDocumentRef, runCut]);

  const handleRazorSplitAll = useCallback(
    async (splitTime: number) => {
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return;
      }
      const splittable = usePlayerStore.getState().elements.filter((element) => {
        if (!canSplitElement(element)) return false;
        const nativeValidity = canSplitNativeElementAt(
          nativeDocumentRef.current,
          element,
          splitTime,
        );
        return nativeValidity ?? canSplitElementAt(element, splitTime);
      });
      if (splittable.length === 0) return;
      try {
        const result = await runCut(splittable, splitTime, "all");
        if (!result) return;
        if (result.syncFailed) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to split clips";
        showToast(message, "error");
      }
    },
    [isRecordingRef, nativeDocumentRef, runCut, showToast],
  );

  return { handleRazorSplit, handleRazorSplitAll, splitForSilence };
}
