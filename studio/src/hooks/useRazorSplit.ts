import { useCallback, useRef, type MutableRefObject } from "react";
import { splitElementInHtml } from "@hyperframes/studio-server/source-mutation";
import type { TimelineElement } from "../player";
import { usePlayerStore } from "../player";
import { getTimelineElementLabel } from "../utils/studioHelpers";
import { trackStudioRazorSplit } from "../telemetry/events";
import { canSplitElement, canSplitElementAt } from "../utils/timelineElementSplit";
import { buildAtomicCutIntents, runAtomicCutTransaction } from "../utils/razorSplitTransaction";
import { applyPatchByTarget } from "../utils/sourcePatcher";
import { splitAudioAutomationInHtml } from "../utils/splitAudioAutomation";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  type NativeClipDomBinding,
  type NativeProjectDocument,
} from "../project/nativeProjectDocument";
import {
  projectFrameFromSeconds,
  resolveNativeClipSelection,
} from "../project/nativePropertyEditPlan";
import {
  commitNativeTimelineSplits,
  type NativeTimelineSplitCompatibilityEdit,
} from "../project/nativeTimelineSplitTransaction";
import { NativeProjectRevisionConflictError } from "../project/nativeProjectPersistence";
import { synchronizeIncomingNativeDocument } from "../project/nativeDocumentRefSync";
import type { RecordEditInput } from "./timelineEditingHelpers";
import { playbackStartAttributeForElement } from "./timelineEditingHelpers";
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
 * project-frame boundary and source-rate checks as the native transaction.
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
  const rate = clip.playbackRate ?? { numerator: 1, denominator: 1 };
  return (
    Number.isSafeInteger(splitFrame) &&
    localFrame > 0 &&
    localFrame < clip.durationFrames &&
    (BigInt(localFrame) * BigInt(rate.numerator)) % BigInt(rate.denominator) === 0n
  );
};

const bindingTarget = (binding: Readonly<NativeClipDomBinding>) => ({
  ...(binding.domId ? { id: binding.domId } : {}),
  ...(binding.hfId ? { hfId: binding.hfId } : {}),
  ...(binding.selector ? { selector: binding.selector } : {}),
  ...(binding.selectorIndex == null ? {} : { selectorIndex: binding.selectorIndex }),
});

const frameSeconds = (frame: number, document: NativeProjectDocument): number =>
  (frame * document.frameRate.denominator) / document.frameRate.numerator;

const patchExactSplitAttributes = (
  content: string,
  target: ReturnType<typeof bindingTarget>,
  values: { startFrame: number; durationFrames: number; sourceInFrame: number },
  document: NativeProjectDocument,
  playbackProperty: "media-start" | "playback-start",
): string => {
  let patched = applyPatchByTarget(content, target, {
    type: "attribute",
    property: "start",
    value: String(frameSeconds(values.startFrame, document)),
  });
  patched = applyPatchByTarget(patched, target, {
    type: "attribute",
    property: "duration",
    value: String(frameSeconds(values.durationFrames, document)),
  });
  return applyPatchByTarget(patched, target, {
    type: "attribute",
    property: playbackProperty,
    value: String(frameSeconds(values.sourceInFrame, document)),
  });
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
            if (!resolution.ok || !resolution.located.clip.binding) {
              throw new Error(
                resolution.ok
                  ? `Native clip ${resolution.located.clip.id} is missing its compatibility binding`
                  : resolution.failure.message,
              );
            }
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
            ) => {
              const element = elements[edit.requestIndex]!;
              const clip = clips[edit.requestIndex]!;
              const leftBinding = edit.leftBinding;
              const baseId = `${leftBinding.domId ?? clip.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-split`;
              const rate = clip.playbackRate ?? { numerator: 1, denominator: 1 };
              const split = splitElementInHtml(
                content,
                bindingTarget(leftBinding),
                edit.compatibilitySplitSeconds,
                baseId,
                {
                  start: frameSeconds(clip.startFrame, document),
                  duration: frameSeconds(clip.durationFrames, document),
                  playbackStart: frameSeconds(clip.sourceInFrame, document),
                  playbackRate: rate.numerator / rate.denominator,
                  stampPlaybackStart: true,
                },
              );
              if (!split.matched || !split.newId) {
                throw new Error(`Compatibility source did not match native clip ${clip.id}`);
              }

              const localFrames = edit.splitFrame - clip.startFrame;
              const sourceDelta =
                (localFrames * rate.numerator) / rate.denominator;
              const playbackProperty = playbackStartAttributeForElement(element).slice(
                "data-".length,
              ) as "media-start" | "playback-start";
              let patched = patchExactSplitAttributes(
                split.html,
                bindingTarget(leftBinding),
                {
                  startFrame: clip.startFrame,
                  durationFrames: localFrames,
                  sourceInFrame: clip.sourceInFrame,
                },
                document,
                playbackProperty,
              );
              const rightBinding: NativeClipDomBinding = {
                sourceFile: edit.sourceFile,
                domId: split.newId,
              };
              patched = splitAudioAutomationInHtml(
                patched,
                bindingTarget(leftBinding),
                bindingTarget(rightBinding),
                frameSeconds(localFrames, document),
              );
              patched = patchExactSplitAttributes(
                patched,
                bindingTarget(rightBinding),
                {
                  startFrame: edit.splitFrame,
                  durationFrames: clip.durationFrames - localFrames,
                  sourceInFrame: clip.sourceInFrame + sourceDelta,
                },
                document,
                playbackProperty,
              );
              return { content: patched, rightBinding };
            },
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
        showToast(`Split ${getTimelineElementLabel(element)} at ${splitTime.toFixed(2)}s`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to split timeline clip";
        showToast(message, "error");
      }
    },
    [isRecordingRef, nativeDocumentRef, runCut, showToast],
  );

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
        showToast(`Split ${result.splitCount} clips at ${splitTime.toFixed(2)}s`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to split clips";
        showToast(message, "error");
      }
    },
    [isRecordingRef, nativeDocumentRef, runCut, showToast],
  );

  return { handleRazorSplit, handleRazorSplitAll };
}
