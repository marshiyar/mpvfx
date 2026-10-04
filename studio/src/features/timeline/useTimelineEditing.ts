import { sourceFrameValue } from "../../../shared/project/nativeSourceTime";
// fallow-ignore-file complexity
import { useCallback, useRef } from "react";
import type { TimelineElement } from "../../player/index";
import { useRazorSplit } from "./useRazorSplit";
import { useTimelineAssetDropOps } from "./useTimelineAssetDropOps";
import {
  patchIframeDomTiming,
  playbackStartAttributeForElement,
  persistTimelineEdit,
  formatTimelineAttributeNumber,
  extendRootDurationIfNeeded,
  buildTimelineResizeTimingPatch,
  buildPatchTarget,
  findTimelineElementInIframe,
} from "./timelineEditingHelpers";
import {
  captureDurationRollback,
  finishClipTimingFallback,
  readFileContent,
  syncPreviewContentDuration,
} from "./timelineTimingSync";
import type { PersistTimelineEditInput } from "./timelineEditingHelpers";
import { useSetAudioGroupAttribute } from "./timelineAudioGroupVolume";
import { useSetElementAttribute } from "./timelineElementFxAttribute";
import { useTimelineDeleteOps } from "./useTimelineDeleteOps";
import { useAudioGroupCarveAssignment } from "./timelineAudioGroupCreate";
import {
  useTimelineElementVisibilityEditing,
  useTimelineTrackVisibilityEditing,
} from "./timelineTrackVisibility";
import { useTimelineGroupEditing } from "./useTimelineGroupEditing";
import { useBlockedTimelineEditToast } from "./useBlockedTimelineEditToast";
import { useRemoveSilence } from "./useRemoveSilence";
import { useNativeAudioActions } from "./useNativeAudioActions";
import { cutoverCommittedOrThrow, sdkTimingPersist } from "../legacy/sdkCutover";
import type { UseTimelineEditingOptions } from "./useTimelineEditingTypes";
import { getStudioSaveErrorMessage } from "../history/studioSaveDiagnostics";
import { commitNativeTimelineRangeEdit } from "../project/nativeTimelineRangeEditTransaction";
import { projectFrameFromSeconds, resolveNativeClipSelection } from "../../../shared/project/nativePropertyEditPlan";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "../project/nativeProjectPersistence";
import { synchronizeIncomingNativeDocument } from "../project/nativeDocumentRefSync";
import { useTimelineClipMove } from "./useTimelineClipMove";

export function useTimelineEditing({
  projectId,
  activeCompPath,
  timelineElements,
  showToast,
  writeProjectFile,
  observeProjectFileVersion,
  recordEdit,
  domEditSaveTimestampRef,
  reloadPreview,
  previewIframeRef,
  pendingTimelineEditPathRef,
  uploadProjectFiles,
  isRecordingRef,
  sdkSession,
  publishSdkSession,
  forceReloadSdkSession,
  invalidateGsapCache,
  handleDomZIndexReorderCommitRef,
  nativeProjectEditing,
}: UseTimelineEditingOptions) {
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const editQueueRef = useRef(Promise.resolve());
  const nativeDocumentRef = useRef(nativeProjectEditing?.nativeDocument ?? null);
  const suppliedNativeDocumentRef = useRef(nativeProjectEditing?.nativeDocument ?? null);
  synchronizeIncomingNativeDocument(
    suppliedNativeDocumentRef,
    nativeDocumentRef,
    nativeProjectEditing?.nativeDocument ?? null,
  );

  const enqueueEdit = useCallback(
    (
      element: TimelineElement,
      label: string,
      buildPatches: PersistTimelineEditInput["buildPatches"],
      coalesceKey?: string,
    ): Promise<void> => {
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return Promise.resolve();
      }
      const pid = projectIdRef.current;
      if (!pid) return Promise.resolve();
      const queued = editQueueRef.current
        .then(() =>
          persistTimelineEdit({
            projectId: pid,
            element,
            activeCompPath,
            label,
            buildPatches,
            writeProjectFile,
            recordEdit,
            domEditSaveTimestampRef,
            pendingTimelineEditPathRef,
            coalesceKey,
          }),
        )
        .then(() => {
          forceReloadSdkSession?.();
        });
      editQueueRef.current = queued.catch((error) => {
        console.error(`[Timeline] Failed to persist: ${label}`, error);
      });
      return queued;
    },
    [
      activeCompPath,
      recordEdit,
      writeProjectFile,
      domEditSaveTimestampRef,
      pendingTimelineEditPathRef,
      showToast,
      isRecordingRef,
      forceReloadSdkSession,
    ],
  );
  const groupEditing = useTimelineGroupEditing({
    activeCompPath,
    domEditSaveTimestampRef,
    editQueueRef,
    forceReloadSdkSession,
    invalidateGsapCache,
    isRecordingRef,
    pendingTimelineEditPathRef,
    previewIframeRef,
    projectIdRef,
    recordEdit,
    reloadPreview,
    sdkSession,
    publishSdkSession,
    showToast,
    writeProjectFile,
    nativeProjectEditing,
    nativeDocumentRef,
  });
  const handleTimelineElementMove = useTimelineClipMove({
    activeCompPath, timelineElements, showToast, writeProjectFile, recordEdit,
    domEditSaveTimestampRef, reloadPreview, previewIframeRef, sdkSession,
    publishSdkSession, forceReloadSdkSession, invalidateGsapCache,
    handleDomZIndexReorderCommitRef, nativeProjectEditing,
    projectIdRef, editQueueRef, nativeDocumentRef, enqueueEdit,
  });

  const handleTimelineElementResize = useCallback(
    // fallow-ignore-next-line complexity
    (
      element: TimelineElement,
      updates: Pick<TimelineElement, "start" | "duration" | "playbackStart">,
    ) => {
      const startChanged = updates.start !== element.start;
      const durationChanged = updates.duration !== element.duration;
      if (!startChanged && !durationChanged) return Promise.resolve();

      const nativeSelection = {
        id: element.id,
        hfId: element.hfId,
        sourceFile: element.sourceFile,
        selector: element.selector,
        selectorIndex: element.selectorIndex,
      };
      const nativeResolution = nativeDocumentRef.current
        ? resolveNativeClipSelection(nativeDocumentRef.current, nativeSelection)
        : null;
      const nativeClipId = nativeResolution?.ok ? nativeResolution.located.clip.id : null;
      const nativeAuthoritative = Boolean(
        nativeResolution?.ok,
      );
      const playbackStartAttr = playbackStartAttributeForElement(element);
      const liveElementBefore = findTimelineElementInIframe(
        previewIframeRef.current,
        element,
        activeCompPath,
      );
      const liveTimingBefore: Array<[string, string | null]> = [
        ["data-start", liveElementBefore?.getAttribute("data-start") ?? null],
        ["data-duration", liveElementBefore?.getAttribute("data-duration") ?? null],
        [playbackStartAttr, liveElementBefore?.getAttribute(playbackStartAttr) ?? null],
      ];
      const liveAttrs: Array<[string, string]> = [
        ["data-start", formatTimelineAttributeNumber(updates.start)],
        ["data-duration", formatTimelineAttributeNumber(updates.duration)],
      ];
      if (updates.playbackStart != null) {
        liveAttrs.push([
          playbackStartAttr,
          formatTimelineAttributeNumber(updates.playbackStart),
        ]);
      }
      patchIframeDomTiming(previewIframeRef.current, element, liveAttrs, activeCompPath);
      // Snapshot the duration BEFORE the optimistic updates below so a failed
      // persist can roll the readout + live root back (see captureDurationRollback).
      const rollbackDuration = captureDurationRollback(previewIframeRef.current);
      // needsExtension gates the SDK path (setTiming can't grow the root duration), so read the store BEFORE the readout sync below optimistically updates it.
      const needsExtension = extendRootDurationIfNeeded(updates.start + updates.duration);
      // Optimistic duration readout: content-driven (grow AND shrink), from the just-patched live DOM. See syncPreviewContentDuration.
      syncPreviewContentDuration(previewIframeRef.current);
      const targetPath = element.sourceFile || activeCompPath || "index.html";
      const buildResizePatches: PersistTimelineEditInput["buildPatches"] = (original, target) => {
        return buildTimelineResizeTimingPatch(original, target, element, updates);
      };
      const hasPbsAdjustment =
        updates.playbackStart != null ||
        (updates.start !== element.start && element.playbackStart != null);
      // Server-path fallback: after persisting the attr patch, scale GSAP tween
      // positions/durations on the server, then soft-reload with the rewritten
      // script (timing-only resize) — same no-flash path as move; full reload is
      // the fallback.
      const coalesceKey = `timeline-resize:${element.hfId ?? element.id}`;
      const finishResizeGsapSync = () =>
        finishClipTimingFallback({
          iframe: previewIframeRef.current,
          reloadPreview,
          projectId: projectIdRef.current,
          targetPath,
          domId: element.domId,
          label: "Resize timeline clip",
          coalesceKey,
          recordEdit,
          edit: {
            kind: "scale",
            from: { start: element.start, duration: element.duration },
            to: { start: updates.start, duration: updates.duration },
          },
        }).finally(() => invalidateGsapCache?.());
      const resizeFallback = () =>
        enqueueEdit(element, "Resize timeline clip", buildResizePatches, coalesceKey).then(
          finishResizeGsapSync,
        );
      const enqueueNativeResize = (): Promise<void> => {
        const operation = editQueueRef.current.then(async () => {
          const currentDocument = nativeDocumentRef.current;
          const dependencies = nativeProjectEditing;
          if (!currentDocument || !dependencies) {
            throw new Error("The authoritative native project is no longer available");
          }
          const commitAgainst = (expectedRevision: number) =>
            commitNativeTimelineRangeEdit({
              expectedRevision,
              element: nativeSelection,
              requestedStartSeconds: updates.start,
              requestedDurationSeconds: updates.duration,
              readOptionalProjectFile: dependencies.readOptionalProjectFile,
              writeProjectFile,
              recordEdit,
              commitFileTransaction: dependencies.commitFileTransaction,
              patchCompatibilityContent: (original, timing, binding) => {
                const target = buildPatchTarget(binding);
                return target ? buildTimelineResizeTimingPatch(
                  original,
                  target,
                  element,
                  {
                    ...updates,
                    playbackStart: Number(timing.sourceOffset),
                  },
                  {
                    start: timing.start,
                    duration: timing.duration,
                    playbackStart: timing.sourceOffset,
                  },
                ) : original;
              },
              onCommitted: (document) => {
                nativeDocumentRef.current = document;
                dependencies.onNativeDocumentCommitted(document);
              },
            });
          let result;
          try {
            result = await commitAgainst(currentDocument.revision);
          } catch (error) {
            if (!(error instanceof NativeProjectRevisionConflictError)) throw error;
            const latestContent = await dependencies.readOptionalProjectFile(
              NATIVE_PROJECT_DOCUMENT_PATH,
            );
            if (!latestContent?.trim()) throw error;
            const latest = parseNativeProjectDocument(JSON.parse(latestContent));
            if (latest.id !== currentDocument.id) throw error;
            nativeDocumentRef.current = latest;
            result = await commitAgainst(latest.revision);
          }
          if (!result.committed) {
            throw new Error(`Native timeline resize was not committed: ${result.message ?? result.reason}`);
          }
          const resizedClip = result.document.sequence.tracks
            .flatMap((track) => track.clips)
            .find((clip) => clip.id === nativeClipId);
          if (!resizedClip) {
            throw new Error("Committed native timeline clip could not be resolved");
          }
          const frameSeconds = (frame: number) =>
            String(
              (frame * result.document.frameRate.denominator) /
                result.document.frameRate.numerator,
            );
          patchIframeDomTiming(
            previewIframeRef.current,
            element,
            [
              ["data-start", frameSeconds(resizedClip.startFrame)],
              ["data-duration", frameSeconds(resizedClip.durationFrames)],
              [playbackStartAttr, frameSeconds(sourceFrameValue(resizedClip))],
            ],
            activeCompPath,
          );
          syncPreviewContentDuration(previewIframeRef.current);
          forceReloadSdkSession?.();
        });
        editQueueRef.current = operation.catch((error) => {
          console.error("[Timeline] Failed to persist native clip range", error);
        });
        return operation;
      };
      const persistDone =
        nativeAuthoritative
          ? enqueueNativeResize()
          : sdkSession && element.hfId && !hasPbsAdjustment && !needsExtension
          ? sdkTimingPersist(
              element.hfId,
              targetPath,
              { start: updates.start, duration: updates.duration },
              sdkSession,
              {
                editHistory: { recordEdit },
                writeProjectFile,
                reloadPreview,
                domEditSaveTimestampRef,
                compositionPath: activeCompPath,
                // Capture on-disk bytes as the undo `before` so undoing a timing
                // resize restores the file verbatim, not a normalized full-DOM re-emit.
                readProjectFile: (path) => readFileContent(projectIdRef.current ?? "", path),
                publishSession: publishSdkSession,
              },
              { label: "Resize timeline clip", coalesceKey, skipRefresh: true },
            ).then((result) => {
              if (!cutoverCommittedOrThrow(result)) return resizeFallback();
              return finishResizeGsapSync();
            })
          : resizeFallback();
      return persistDone.catch((error) => {
        // Failed persist: revert the optimistic duration readout + live root.
        patchIframeDomTiming(
          previewIframeRef.current,
          element,
          liveTimingBefore,
          activeCompPath,
        );
        rollbackDuration();
        showToast(getStudioSaveErrorMessage(error), "error");
        throw error;
      });
    },
    [
      previewIframeRef,
      enqueueEdit,
      activeCompPath,
      sdkSession,
      publishSdkSession,
      recordEdit,
      writeProjectFile,
      reloadPreview,
      domEditSaveTimestampRef,
      showToast,
      invalidateGsapCache,
      nativeProjectEditing,
      forceReloadSdkSession,
    ],
  );

  const handleToggleTrackHidden = useTimelineTrackVisibilityEditing({
    projectIdRef,
    activeCompPath,
    timelineElements,
    showToast,
    writeProjectFile,
    recordEdit,
    domEditSaveTimestampRef,
    previewIframeRef,
    pendingTimelineEditPathRef,
    isRecordingRef,
    forceReloadSdkSession,
  });

  const handleToggleElementHidden = useTimelineElementVisibilityEditing({
    projectIdRef,
    activeCompPath,
    showToast,
    writeProjectFile,
    recordEdit,
    domEditSaveTimestampRef,
    previewIframeRef,
    pendingTimelineEditPathRef,
    isRecordingRef,
    forceReloadSdkSession,
  });

  const handleAutoGroupCarveSources = useAudioGroupCarveAssignment({
    projectIdRef,
    activeCompPath,
    showToast,
    writeProjectFile,
    recordEdit,
    domEditSaveTimestampRef,
    previewIframeRef,
    pendingTimelineEditPathRef,
    isRecordingRef,
    nativeProjectEditing,
    nativeDocumentRef,
    editQueueRef,
  });

  const { handleNativeAudioAction } = useNativeAudioActions({
    projectIdRef, nativeProjectEditing, nativeDocumentRef, editQueueRef,
    writeProjectFile, recordEdit, showToast, domEditSaveTimestampRef,
    pendingTimelineEditPathRef, reloadPreview, forceReloadSdkSession, isRecordingRef,
  });

  const setElementFxAttribute = useSetElementAttribute({
    projectIdRef,
    activeCompPath,
    showToast,
    writeProjectFile,
    recordEdit,
    domEditSaveTimestampRef,
    previewIframeRef,
    pendingTimelineEditPathRef,
    isRecordingRef,
    nativeProjectEditing,
    nativeDocumentRef,
    editQueueRef,
    reloadPreview,
  });

  const setAudioGroupAttribute = useSetAudioGroupAttribute({
    projectIdRef,
    activeCompPath,
    showToast,
    writeProjectFile,
    recordEdit,
    domEditSaveTimestampRef,
    previewIframeRef,
    pendingTimelineEditPathRef,
    isRecordingRef,
    nativeProjectEditing,
    nativeDocumentRef,
    editQueueRef,
  });

  const { handleTimelineElementsDelete, handleTimelineElementDelete } = useTimelineDeleteOps({
    projectIdRef,
    activeCompPath,
    timelineElements,
    showToast,
    writeProjectFile,
    recordEdit,
    domEditSaveTimestampRef,
    reloadPreview,
    isRecordingRef,
    forceReloadSdkSession,
    previewIframeRef,
    nativeProjectEditing,
    nativeDocumentRef,
    editQueueRef,
  });

  const { handleTimelineAssetDrop, handleTimelineFileDrop, handleTimelineCompositionDrop } =
    useTimelineAssetDropOps({
      projectIdRef,
      activeCompPath,
      timelineElements,
      showToast,
      writeProjectFile,
      recordEdit,
      domEditSaveTimestampRef,
      reloadPreview,
      uploadProjectFiles,
      isRecordingRef,
      forceReloadSdkSession,
      observeProjectFileVersion,
      nativeProjectEditing,
      nativeDocumentRef,
      editQueueRef,
    });

  const handleBlockedTimelineEdit = useBlockedTimelineEditToast(showToast);

  const { handleRazorSplit, handleRazorSplitAll, splitForSilence } = useRazorSplit({
    projectId,
    activeCompPath,
    showToast,
    writeProjectFile,
    observeProjectFileVersion,
    recordEdit,
    domEditSaveTimestampRef,
    reloadPreview,
    isRecordingRef,
    forceReloadSdkSession,
    nativeProjectEditing,
    nativeDocumentRef,
    editQueueRef,
  });

  const { handleRemoveSilence, isRemovingSilence } = useRemoveSilence({
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
    deleteElements: handleTimelineElementsDelete,
    moveElement: handleTimelineElementMove,
    splitElement: splitForSilence,
    nativeProjectEditing,
    nativeDocumentRef,
    editQueueRef,
    snapTimelineTime: (time) => {
      const document = nativeDocumentRef.current;
      if (!document) return time;
      return projectFrameFromSeconds(time, document.frameRate) * document.frameRate.denominator / document.frameRate.numerator;
    },
    isNativeElement: (element) => {
      const document = nativeDocumentRef.current;
      if (!nativeProjectEditing || !document) return false;
      return resolveNativeClipSelection(document, {
        id: element.id,
        hfId: element.hfId,
        sourceFile: element.sourceFile,
        selector: element.selector,
        selectorIndex: element.selectorIndex,
      }).ok;
    },
  });

  return {
    handleTimelineElementMove,
    handleTimelineElementResize,
    handleToggleTrackHidden,
    handleToggleElementHidden,
    handleAutoGroupCarveSources,
    handleNativeAudioAction,
    setAudioGroupAttribute,
    setElementFxAttribute,
    handleTimelineElementDelete,
    handleTimelineElementsDelete,
    handleTimelineElementSplit: handleRazorSplit,
    handleRazorSplit,
    handleRazorSplitAll,
    handleRemoveSilence,
    isRemovingSilence,
    handleTimelineAssetDrop,
    handleTimelineFileDrop,
    handleTimelineCompositionDrop,
    handleBlockedTimelineEdit,
    ...groupEditing,
  };
}
