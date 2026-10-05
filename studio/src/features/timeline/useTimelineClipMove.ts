/** Single-clip move persistence, including native lane mapping and live rollback. */
import { useCallback, type MutableRefObject } from "react";
import type { TimelineElement } from "../../player/index";
import {
  applyTimelineStackingReorder, patchIframeDomTiming,
  formatTimelineAttributeNumber, extendRootDurationIfNeeded,
  buildTimelineMoveTimingPatch, buildPatchTarget,
} from "./timelineEditingHelpers";
import type { PersistTimelineEditInput } from "./timelineEditingHelpers";
import {
  captureDurationRollback, finishClipTimingFallback,
  readFileContent, syncPreviewContentDuration,
} from "./timelineTimingSync";
import { serializeZLaneGesture } from "./zLaneGesture";
import { cutoverCommittedOrThrow, sdkTimingPersist } from "../legacy/sdkCutover";
import type { TimelineMoveUpdates, UseTimelineEditingOptions } from "./useTimelineEditingTypes";
import { getStudioSaveErrorMessage } from "../history/studioSaveDiagnostics";
import { trackStudioPendingEdit } from "../history/studioPendingEdits";
import { commitNativeTimelineMove } from "../project/nativeTimelineMoveTransaction";
import { resolveNativeClipSelection } from "../../../shared/project/nativePropertyEditPlan";
import {
  NATIVE_PROJECT_DOCUMENT_PATH, parseNativeProjectDocument,
  type NativeProjectDocument,
} from "../../../shared/project/nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "../project/nativeProjectPersistence";
import { applyRemoteTimelineStackingReorder } from "./remoteTimelineStackingReorder";
import { generateId } from "../../lib/generateId";

type MoveOptions = Pick<UseTimelineEditingOptions,
  "activeCompPath" | "timelineElements" | "showToast" | "writeProjectFile" |
  "recordEdit" | "domEditSaveTimestampRef" | "reloadPreview" |
  "previewIframeRef" | "sdkSession" | "publishSdkSession" |
  "forceReloadSdkSession" | "invalidateGsapCache" |
  "handleDomZIndexReorderCommitRef" | "nativeProjectEditing"
> & {
  projectIdRef: MutableRefObject<string | null>;
  editQueueRef: MutableRefObject<Promise<unknown>>;
  nativeDocumentRef: MutableRefObject<NativeProjectDocument | null>;
  enqueueEdit: (
    element: TimelineElement,
    label: string,
    buildPatches: PersistTimelineEditInput["buildPatches"],
    coalesceKey?: string,
  ) => Promise<void>;
};

export function useTimelineClipMove({
  activeCompPath, timelineElements, showToast, writeProjectFile, recordEdit,
  domEditSaveTimestampRef, reloadPreview, previewIframeRef, sdkSession,
  publishSdkSession, forceReloadSdkSession, invalidateGsapCache,
  handleDomZIndexReorderCommitRef, nativeProjectEditing,
  projectIdRef, editQueueRef, nativeDocumentRef, enqueueEdit,
}: MoveOptions) {
  const handleTimelineElementMove = useCallback(
    // fallow-ignore-next-line complexity
    (element: TimelineElement, updates: TimelineMoveUpdates) => {
      const commitMove = () => {
        const targetPath = element.sourceFile || activeCompPath || "index.html";
        const startChanged = updates.start !== element.start;
        // A vertical-only lane move arrives with start unchanged but track changed
        // (on this single-element path the drag commit has already folded the
        // AUTHORED persist track into updates.track). It must persist like any
        // other move — early-returning on !startChanged alone silently dropped
        // the file write, so the lane snapped back on reload.
        const trackChanged = updates.track !== element.track;
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

        if (startChanged || trackChanged) {
          const liveAttrs: Array<[string, string]> = [];
          if (startChanged) {
            liveAttrs.push(["data-start", formatTimelineAttributeNumber(updates.start)]);
          }
          if (trackChanged) {
            liveAttrs.push(["data-track-index", formatTimelineAttributeNumber(updates.track)]);
          }
          patchIframeDomTiming(previewIframeRef.current, element, liveAttrs, activeCompPath);
        }

        const coalesceKey = `timeline-move:${element.hfId ?? element.id}`;
        const iframe = previewIframeRef.current;
        let isolated = false;
        try { isolated = Boolean(iframe && !iframe.contentDocument); } catch { isolated = true; }
        const remoteGestureKey = isolated && nativeClipId && updates.stackingReorder
          ? `timeline-move:${nativeClipId}:${generateId()}` : null;
        let remoteZChanged = false;
        const reorderDone = isolated && iframe && nativeAuthoritative && updates.stackingReorder &&
          nativeProjectEditing && projectIdRef.current
          ? applyRemoteTimelineStackingReorder({
              iframe, projectId: projectIdRef.current, intent: updates.stackingReorder,
              timelineElements, activeCompPath, coalesceKey: remoteGestureKey ?? coalesceKey,
              deps: { readOptionalProjectFile: nativeProjectEditing.readOptionalProjectFile,
                writeProjectFile, recordEdit,
                commitFileTransaction: nativeProjectEditing.commitFileTransaction },
            }).then(changed => { remoteZChanged = changed; })
          : applyTimelineStackingReorder({
              element, stackingReorder: updates.stackingReorder, timelineElements,
              iframe, activeCompPath, commit: handleDomZIndexReorderCommitRef?.current,
              coalesceKey,
            });

        if (!startChanged && !trackChanged) return reorderDone.then(() => {
          if (remoteZChanged) reloadPreview();
        });

        // Snapshot the duration BEFORE the optimistic updates below so a failed
        // persist can roll the readout + live root back (see captureDurationRollback).
        const rollbackDuration = captureDurationRollback(previewIframeRef.current);
        const rollbackLiveTiming = () => {
          const liveAttrs: Array<[string, string]> = [];
          if (startChanged) {
            liveAttrs.push(["data-start", formatTimelineAttributeNumber(element.start)]);
          }
          if (trackChanged) {
            liveAttrs.push([
              "data-track-index",
              formatTimelineAttributeNumber(element.authoredTrack ?? element.track),
            ]);
          }
          if (liveAttrs.length > 0) {
            patchIframeDomTiming(previewIframeRef.current, element, liveAttrs, activeCompPath);
          }
        };
        // needsExtension gates the SDK path (setTiming can't grow the root duration), so read the store BEFORE the readout sync below optimistically updates it.
        const needsExtension = extendRootDurationIfNeeded(updates.start + element.duration);
        // Optimistic duration readout: content-driven (grow AND shrink), from the just-patched live DOM. See syncPreviewContentDuration.
        syncPreviewContentDuration(previewIframeRef.current);

        const buildMovePatches: PersistTimelineEditInput["buildPatches"] = (original, target) => {
          // Persist lane changes too — data-start-only writes let reload snap the lane back.
          const track = trackChanged ? updates.track : undefined;
          return buildTimelineMoveTimingPatch(
            original,
            target,
            updates.start,
            element.duration,
            track,
          );
        };
        const finishMoveGsapSync = () =>
          // Every timing writer converges the same GSAP positions after its
          // durable clip-start commit. The SDK owns the attribute write; this
          // sync owns only the dependent animation rewrite and preview refresh.
          finishClipTimingFallback({
            iframe: previewIframeRef.current,
            reloadPreview,
            projectId: projectIdRef.current,
            targetPath,
            domId: element.domId,
            label: "Move timeline clip",
            coalesceKey,
            recordEdit,
            edit: { kind: "shift", delta: updates.start - element.start },
          }).finally(() => invalidateGsapCache?.());
        const moveFallback = () =>
          enqueueEdit(element, "Move timeline clip", buildMovePatches, coalesceKey).then(
            finishMoveGsapSync,
          );
        const enqueueNativeMove = (): Promise<void> => {
          const operation = editQueueRef.current.then(async () => {
            const currentDocument = nativeDocumentRef.current;
            const dependencies = nativeProjectEditing;
            if (!currentDocument || !dependencies) {
              throw new Error("The authoritative native project is no longer available");
            }
            const commitAgainst = (expectedRevision: number) =>
              commitNativeTimelineMove({
                expectedRevision,
                element: {
                  ...nativeSelection,
                  currentTrack: element.track,
                },
                requestedStartSeconds: updates.start,
                requestedTrack: updates.track,
                readOptionalProjectFile: dependencies.readOptionalProjectFile,
                writeProjectFile,
                recordEdit,
                gestureCoalesceKey: remoteGestureKey ?? undefined,
                commitFileTransaction: dependencies.commitFileTransaction,
                patchCompatibilityContent: (original, exactStartSeconds, destinationLane, binding) => {
                  // The native binding identifies the authored source; the
                  // preview element may contain runtime-only IDs.
                  const target = buildPatchTarget(binding);
                  return target ? buildTimelineMoveTimingPatch(
                    original,
                    target,
                    exactStartSeconds,
                    element.duration,
                    trackChanged ? destinationLane.authoredTrack : undefined,
                    String(exactStartSeconds),
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
              // One semantic rebase is safe: the transaction performed no
              // writes before reporting the CAS conflict, and the planner will
              // resolve the exact binding again against these fresh bytes.
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
              if (result.reason === "unsupported-lane-change") {
                throw new Error(
                  "Native timeline clip cannot change lanes: the destination has no compatible authored lane mapping",
                );
              }
              throw new Error(`Native timeline move was not committed: ${result.reason}`);
            }
            const destinationTrack = result.document.sequence.tracks.find((track) =>
              track.clips.some((clip) => clip.id === nativeClipId),
            );
            const movedClip = destinationTrack?.clips.find((clip) => clip.id === nativeClipId);
            if (!movedClip) {
              throw new Error("Committed native timeline clip could not be resolved");
            }
            const exactStartSeconds =
              (movedClip.startFrame * result.document.frameRate.denominator) /
              result.document.frameRate.numerator;
            const exactLiveAttrs: Array<[string, string]> = [
              ["data-start", String(exactStartSeconds)],
            ];
            if (trackChanged && destinationTrack?.lane) {
              exactLiveAttrs.push([
                "data-track-index",
                String(destinationTrack.lane.authoredTrack),
              ]);
            }
            patchIframeDomTiming(
              previewIframeRef.current,
              element,
              exactLiveAttrs,
              activeCompPath,
            );
            syncPreviewContentDuration(previewIframeRef.current);
            forceReloadSdkSession?.();
          });
          editQueueRef.current = operation.catch((error) => {
            console.error("[Timeline] Failed to persist native clip move", error);
          });
          return operation;
        };
        return reorderDone
          .then(() => {
            if (nativeAuthoritative && (startChanged || trackChanged)) {
              return enqueueNativeMove().then(() => { if (remoteZChanged) reloadPreview(); });
            }
            // The SDK setTiming path writes start only — a lane change must take
            // the fallback, whose patch builder writes data-track-index too.
            if (sdkSession && element.hfId && !needsExtension && !trackChanged) {
              return sdkTimingPersist(
                element.hfId,
                targetPath,
                { start: updates.start },
                sdkSession,
                {
                  editHistory: { recordEdit },
                  writeProjectFile,
                  reloadPreview,
                  domEditSaveTimestampRef,
                  compositionPath: activeCompPath,
                  // Capture on-disk bytes as the undo `before` so undoing a timing move
                  // restores the file verbatim, not a normalized full-DOM re-emit.
                  readProjectFile: (path) => readFileContent(projectIdRef.current ?? "", path),
                  publishSession: publishSdkSession,
                },
                { label: "Move timeline clip", coalesceKey, skipRefresh: true },
              ).then((result) => {
                if (!cutoverCommittedOrThrow(result)) return moveFallback();
                return finishMoveGsapSync();
              });
            }
            return moveFallback();
          })
          .catch((error) => {
            // Failed persist: revert the optimistic duration readout + live root.
            rollbackLiveTiming();
            rollbackDuration();
            showToast(getStudioSaveErrorMessage(error), "error");
            throw error;
          });
      };
      const operation = updates.stackingReorder ? serializeZLaneGesture(commitMove) : commitMove();
      // Undo must choose its history entry after both timing and animation
      // persistence finish, including a lane move queued behind another gesture.
      trackStudioPendingEdit(operation);
      return operation;
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
      timelineElements,
      handleDomZIndexReorderCommitRef,
      showToast,
      invalidateGsapCache,
      nativeProjectEditing,
      forceReloadSdkSession,
    ],
  );

  return handleTimelineElementMove;
}
