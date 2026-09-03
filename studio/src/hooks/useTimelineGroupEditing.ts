// fallow-ignore-file code-duplication
// Move/resize operation families remain parallel until SDK graduation.
import { useCallback, type MutableRefObject, type RefObject } from "react";
import type { Composition } from "@hyperframes/sdk";
import type { TimelineElement } from "../player";
import {
  cutoverCommittedOrThrow,
  sdkTimingBatchPersist,
  type PublishSdkSession,
} from "../utils/sdkCutover";
import {
  buildTimelineMoveTimingPatch,
  buildTimelineResizeTimingPatch,
  buildPatchTarget,
  extendRootDurationIfNeeded,
  findTimelineElementInIframe,
  formatTimelineAttributeNumber,
  patchIframeDomTiming,
  playbackStartAttributeForElement,
  persistTimelineBatchEdit,
  type PersistTimelineBatchChange,
  type RecordEditInput,
} from "./timelineEditingHelpers";
import {
  captureDurationRollback,
  finishGroupTimingGsapFallback,
  readFileContent,
  scaleGsapPositions,
  shiftGsapPositions,
  syncPreviewContentDuration,
} from "./timelineTimingSync";
import { getStudioSaveErrorMessage } from "../utils/studioSaveDiagnostics";
import { commitNativeTimelineMultiMove } from "../project/nativeTimelineMultiMoveTransaction";
import { commitNativeTimelineMultiRangeEdit } from "../project/nativeTimelineMultiRangeEditTransaction";
import { resolveNativeClipSelection } from "../project/nativePropertyEditPlan";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "../project/nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "../project/nativeProjectPersistence";
import type { NativeTimelineEditingDependencies } from "./useTimelineEditingTypes";

export interface TimelineGroupMoveChange {
  element: TimelineElement;
  start: number;
  track?: number;
  /** Unambiguous source-file lane when this is a vertical gesture. */
  authoredTrack?: number;
  /** Unambiguous UI row when this is a vertical gesture. */
  displayTrack?: number;
}

export interface TimelineGroupResizeChange {
  element: TimelineElement;
  start: number;
  duration: number;
  playbackStart?: number;
}

export interface TimelineGroupCommitOptions {
  beforeTiming?: Promise<void>;
  coalesceKey?: string;
  /** Per-entry undo coalesce window override (ms) — see EditHistoryEntry.coalesceMs. */
  coalesceMs?: number;
}

interface UseTimelineGroupEditingOptions {
  activeCompPath: string | null;
  domEditSaveTimestampRef: MutableRefObject<number>;
  editQueueRef: MutableRefObject<Promise<unknown>>;
  forceReloadSdkSession?: () => void;
  invalidateGsapCache?: () => void;
  isRecordingRef?: RefObject<boolean>;
  pendingTimelineEditPathRef: MutableRefObject<Set<string>>;
  previewIframeRef: RefObject<HTMLIFrameElement | null>;
  projectIdRef: MutableRefObject<string | null>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  reloadPreview: () => void;
  sdkSession?: Composition | null;
  publishSdkSession?: PublishSdkSession;
  showToast: (message: string, tone?: "error" | "info") => void;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  nativeProjectEditing?: NativeTimelineEditingDependencies;
  nativeDocumentRef: MutableRefObject<NativeProjectDocument | null>;
}

function targetPathFor(element: TimelineElement, activeCompPath: string | null): string {
  return element.sourceFile || activeCompPath || "index.html";
}

function allChangesSharePath(
  changes: readonly { element: TimelineElement }[],
  activeCompPath: string | null,
): string | null {
  const firstPath = changes[0] ? targetPathFor(changes[0].element, activeCompPath) : null;
  if (!firstPath) return null;
  return changes.every((change) => targetPathFor(change.element, activeCompPath) === firstPath)
    ? firstPath
    : null;
}

function moveCoalesceKey(changes: readonly TimelineGroupMoveChange[]): string {
  return `timeline-group-move:${changes.map((change) => change.element.hfId ?? change.element.id).join(",")}`;
}

function resizeCoalesceKey(changes: readonly TimelineGroupResizeChange[]): string {
  return `timeline-group-resize:${changes.map((change) => change.element.hfId ?? change.element.id).join(",")}`;
}

function toSdkTimingChanges<T extends { element: TimelineElement }>(
  changes: readonly T[],
  timingUpdate: (change: T) => { start: number; duration?: number },
): Array<{ hfId: string; timingUpdate: { start: number; duration?: number } } | null> {
  return changes.map((change) =>
    change.element.hfId ? { hfId: change.element.hfId, timingUpdate: timingUpdate(change) } : null,
  );
}

function resizeHasPlaybackStartAdjustment(change: TimelineGroupResizeChange): boolean {
  return (
    change.playbackStart != null ||
    (change.start !== change.element.start && change.element.playbackStart != null)
  );
}

export function useTimelineGroupEditing({
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
}: UseTimelineGroupEditingOptions) {
  const enqueueGroupOperation = useCallback(
    (label: string, operation: (projectId: string) => Promise<void>): Promise<void> => {
      if (isRecordingRef?.current) {
        showToast("Cannot edit timeline while recording", "error");
        return Promise.reject(new Error(`${label}: blocked while recording`));
      }
      const projectId = projectIdRef.current;
      if (!projectId) return Promise.reject(new Error(`${label}: no active project`));
      const run = editQueueRef.current.then(() => operation(projectId));
      // Keep the shared edit queue from wedging on a rejection, but return the raw
      // (rejecting) promise so the gesture owner can roll back on a real failure.
      editQueueRef.current = run.then(
        () => undefined,
        (error) => {
          console.error(`[Timeline] Failed to persist: ${label}`, error);
        },
      );
      return run;
    },
    [editQueueRef, isRecordingRef, projectIdRef, showToast],
  );

  const persistServerBatch = useCallback(
    async (
      projectId: string,
      label: string,
      batchChanges: PersistTimelineBatchChange[],
      coalesceKey: string,
      coalesceMs?: number,
    ) => {
      await persistTimelineBatchEdit({
        projectId,
        activeCompPath,
        label,
        changes: batchChanges,
        writeProjectFile,
        recordEdit,
        domEditSaveTimestampRef,
        pendingTimelineEditPathRef,
        coalesceKey,
        coalesceMs,
      });
      forceReloadSdkSession?.();
    },
    [
      activeCompPath,
      domEditSaveTimestampRef,
      forceReloadSdkSession,
      pendingTimelineEditPathRef,
      recordEdit,
      writeProjectFile,
    ],
  );

  // Shared SDK fast path for group move/resize: eligible when nothing needs the
  // server (no root-duration growth, one shared file, every change SDK-addressable
  // and `eligible` per the caller's own gate). Returns whether the SDK handled it;
  // false → caller falls through to the server batch persist.
  const trySdkBatchPersist = useCallback(
    async (input: {
      changes: readonly { element: TimelineElement }[];
      sdkChanges: Array<{
        hfId: string;
        timingUpdate: { start: number; duration?: number };
      } | null>;
      eligible: boolean;
      needsExtension: boolean;
      label: string;
      coalesceKey: string;
      coalesceMs?: number;
    }): Promise<boolean> => {
      const sharedPath = allChangesSharePath(input.changes, activeCompPath);
      const canUseSdk =
        !input.needsExtension &&
        sharedPath !== null &&
        input.eligible &&
        input.sdkChanges.every((change) => change !== null);
      if (!canUseSdk) return false;
      const result = await sdkTimingBatchPersist(
        input.sdkChanges.filter((change): change is NonNullable<typeof change> => change !== null),
        sharedPath,
        sdkSession,
        {
          editHistory: { recordEdit },
          writeProjectFile,
          reloadPreview,
          domEditSaveTimestampRef,
          compositionPath: activeCompPath,
          readProjectFile: (path) => readFileContent(projectIdRef.current ?? "", path),
          publishSession: publishSdkSession,
        },
        {
          label: input.label,
          coalesceKey: input.coalesceKey,
          coalesceMs: input.coalesceMs,
          skipRefresh: true,
        },
      );
      return cutoverCommittedOrThrow(result);
    },
    [
      activeCompPath,
      domEditSaveTimestampRef,
      projectIdRef,
      publishSdkSession,
      recordEdit,
      reloadPreview,
      sdkSession,
      writeProjectFile,
    ],
  );

  const handleTimelineGroupMove = useCallback(
    (changes: TimelineGroupMoveChange[], options?: TimelineGroupCommitOptions) => {
      if (changes.length === 0) return Promise.resolve();
      const nativeEntries: Array<{
        change: TimelineGroupMoveChange;
        clipId: string;
      }> = [];
      if (nativeDocumentRef.current) {
        for (const change of changes) {
          const resolution = resolveNativeClipSelection(nativeDocumentRef.current, {
            id: change.element.id,
            hfId: change.element.hfId,
            sourceFile: change.element.sourceFile,
            selector: change.element.selector,
            selectorIndex: change.element.selectorIndex,
          });
          if (resolution.ok && resolution.located.clip.binding) {
            nativeEntries.push({ change, clipId: resolution.located.clip.id });
          }
        }
      }
      if (nativeEntries.length > 0 && nativeEntries.length !== changes.length) {
        const error = new Error(
          "A timeline gesture cannot mix native-owned and legacy-only clips",
        );
        showToast(error.message, "error");
        return Promise.reject(error);
      }
      const nativeAuthoritative = nativeEntries.length === changes.length;
      const nativeChangeByClipId = new Map(
        nativeEntries.map((entry) => [entry.clipId, entry.change]),
      );
      const liveTimingBefore = changes.map((change) => {
        const live = findTimelineElementInIframe(
          previewIframeRef.current,
          change.element,
          activeCompPath,
        );
        const attrs: Array<[string, string | null]> = [
          ["data-start", live?.getAttribute("data-start") ?? null],
        ];
        if (change.track != null || change.authoredTrack != null) {
          attrs.push(["data-track-index", live?.getAttribute("data-track-index") ?? null]);
        }
        return { change, attrs };
      });
      for (const change of changes) {
        const attrs: Array<[string, string]> = [
          ["data-start", formatTimelineAttributeNumber(change.start)],
        ];
        if (change.track != null) {
          attrs.push(["data-track-index", formatTimelineAttributeNumber(change.track)]);
        }
        patchIframeDomTiming(previewIframeRef.current, change.element, attrs, activeCompPath);
      }

      // TRACK-ONLY batch: every change keeps its start (moves never carry a
      // duration change), so nothing timing-related changed — the batch only
      // rewrites data-track-index, which the renderer never reads (documented
      // in core runtime/timeline.ts; track is a studio lane concept). The live
      // DOM patch above + the gesture owner's optimistic store update cover the
      // in-flight UI; after the complete lane + z transaction, that owner
      // refreshes the preview so its runtime manifest converges to disk. There
      // is still nothing to GSAP-shift here, so skip this fallback entirely.
      // Running it anyway is what made the mirrored z-order lane move blink —
      // a zero-delta batch yields no scriptText, and finishGroupTimingGsapFallback
      // used to full-reload the iframe when there was no script to soft-swap
      // (it now rebinds the runtime timing in place, but a track-only batch
      // needs NO preview sync at all, so the skip stays).
      const trackOnly = changes.every((change) => change.start === change.element.start);

      const maxEnd = Math.max(...changes.map((change) => change.start + change.element.duration));
      // Snapshot the duration BEFORE the optimistic updates below so a failed
      // persist can roll the readout + live root back (see captureDurationRollback).
      const rollbackDuration = captureDurationRollback(previewIframeRef.current);
      // needsExtension gates the SDK path (setTiming can't grow the root duration),
      // so read the store BEFORE the readout sync below optimistically updates it.
      // Track-only batches leave every clip end unchanged, so both this and the
      // readout sync below are provable no-ops there — kept unconditional so the
      // duration machinery stays on one code path.
      const needsExtension = extendRootDurationIfNeeded(maxEnd);
      // Optimistic duration readout: content-driven (grow AND shrink), read from
      // the just-patched live DOM. See syncPreviewContentDuration.
      syncPreviewContentDuration(previewIframeRef.current);
      const coalesceKey = options?.coalesceKey ?? moveCoalesceKey(changes);
      const coalesceMs = options?.coalesceMs;
      return enqueueGroupOperation("Move timeline clips", async (projectId) => {
        await options?.beforeTiming;
        if (nativeAuthoritative) {
          const currentDocument = nativeDocumentRef.current;
          const dependencies = nativeProjectEditing;
          if (!currentDocument || !dependencies) {
            throw new Error("The authoritative native project is no longer available");
          }
          const commitAgainst = (expectedRevision: number) =>
            commitNativeTimelineMultiMove({
              expectedRevision,
              changes: changes.map((change) => ({
                element: {
                  id: change.element.id,
                  hfId: change.element.hfId,
                  sourceFile: change.element.sourceFile,
                  selector: change.element.selector,
                  selectorIndex: change.element.selectorIndex,
                },
                requestedStartSeconds: change.start,
                destinationAuthoredTrack:
                  change.authoredTrack ?? change.track ?? undefined,
              })),
              readOptionalProjectFile: dependencies.readOptionalProjectFile,
              writeProjectFile,
              recordEdit,
              commitFileTransaction: dependencies.commitFileTransaction,
              coalesceKey,
              coalesceMs,
              patchCompatibilityContent: (original, edit) => {
                const change = nativeChangeByClipId.get(edit.address.clipId);
                const target = change ? buildPatchTarget(change.element) : null;
                if (!change || !target) return original;
                return buildTimelineMoveTimingPatch(
                  original,
                  target,
                  edit.exactStartSeconds,
                  change.element.duration,
                  change.track != null || change.authoredTrack != null
                    ? edit.destination.authoredTrack
                    : undefined,
                  String(edit.exactStartSeconds),
                );
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
            throw new Error(`Native timeline group move was not committed: ${result.reason}`);
          }
          for (const edit of result.moves) {
            const change = nativeChangeByClipId.get(edit.address.clipId);
            if (!change) continue;
            const attrs: Array<[string, string]> = [
              ["data-start", String(edit.compatibilityStartSeconds)],
            ];
            if (change.track != null || change.authoredTrack != null) {
              attrs.push(["data-track-index", String(edit.destination.authoredTrack)]);
            }
            patchIframeDomTiming(
              previewIframeRef.current,
              change.element,
              attrs,
              activeCompPath,
            );
          }
          syncPreviewContentDuration(previewIframeRef.current);
          forceReloadSdkSession?.();
          return;
        }
        const handledBySdk = await trySdkBatchPersist({
          changes,
          sdkChanges: toSdkTimingChanges(changes, (change) => ({ start: change.start })),
          eligible: changes.every((change) => change.track == null),
          needsExtension,
          label: "Move timeline clips",
          coalesceKey,
          coalesceMs,
        });
        if (!handledBySdk) {
          await persistServerBatch(
            projectId,
            "Move timeline clips",
            changes.map((change) => ({
              element: change.element,
              buildPatches: (original, target) =>
                buildTimelineMoveTimingPatch(
                  original,
                  target,
                  change.start,
                  change.element.duration,
                  change.track,
                ),
            })),
            coalesceKey,
            coalesceMs,
          );
        }
        // Track-only: no timing delta → no GSAP positions to shift and no
        // reload (see the trackOnly doc above). Mixed batches (any start
        // change) keep the full fallback below.
        if (trackOnly) return;
        // The timing persist above already committed to disk, so the cached
        // GSAP read is stale whether or not the position rewrite succeeded —
        // invalidate on the error path too (matches the single-element path's
        // `.finally`), or a failed rewrite leaves the editor reading old tweens.
        try {
          await finishGroupTimingGsapFallback({
            projectId,
            iframe: previewIframeRef.current,
            reloadPreview,
            label: "Move timeline clips",
            errorLabel: "Failed to shift GSAP positions",
            coalesceKey,
            recordEdit,
            activeCompPath,
            changes,
            resolveChangePath: (element) => targetPathFor(element, activeCompPath),
            mutateChange: (change, changePath) => {
              const delta = change.start - change.element.start;
              const domId = change.element.domId;
              if (delta === 0 || !domId) return null;
              return shiftGsapPositions(projectId, changePath, domId, delta);
            },
          });
        } finally {
          invalidateGsapCache?.();
        }
      }).catch((error) => {
        // Failed persist: revert the optimistic duration readout + live root
        // alongside the gesture owner's store rollback.
        for (const snapshot of liveTimingBefore) {
          patchIframeDomTiming(
            previewIframeRef.current,
            snapshot.change.element,
            snapshot.attrs,
            activeCompPath,
          );
        }
        rollbackDuration();
        showToast(getStudioSaveErrorMessage(error), "error");
        throw error;
      });
    },
    [
      activeCompPath,
      enqueueGroupOperation,
      persistServerBatch,
      previewIframeRef,
      recordEdit,
      reloadPreview,
      trySdkBatchPersist,
      showToast,
      invalidateGsapCache,
      nativeProjectEditing,
      nativeDocumentRef,
      forceReloadSdkSession,
    ],
  );

  const handleTimelineGroupResize = useCallback(
    (changes: TimelineGroupResizeChange[], options?: TimelineGroupCommitOptions) => {
      if (changes.length === 0) return Promise.resolve();
      const nativeEntries: Array<{
        change: TimelineGroupResizeChange;
        clipId: string;
      }> = [];
      if (nativeDocumentRef.current) {
        for (const change of changes) {
          const resolution = resolveNativeClipSelection(nativeDocumentRef.current, {
            id: change.element.id,
            hfId: change.element.hfId,
            sourceFile: change.element.sourceFile,
            selector: change.element.selector,
            selectorIndex: change.element.selectorIndex,
          });
          if (resolution.ok && resolution.located.clip.binding) {
            nativeEntries.push({ change, clipId: resolution.located.clip.id });
          }
        }
      }
      if (nativeEntries.length > 0 && nativeEntries.length !== changes.length) {
        const error = new Error(
          "A timeline gesture cannot mix native-owned and legacy-only clips",
        );
        showToast(error.message, "error");
        return Promise.reject(error);
      }
      const nativeAuthoritative = nativeEntries.length === changes.length;
      const nativeChangeByClipId = new Map(
        nativeEntries.map((entry) => [entry.clipId, entry.change]),
      );
      const liveTimingBefore = changes.map((change) => {
        const playbackAttr = playbackStartAttributeForElement(change.element);
        const live = findTimelineElementInIframe(
          previewIframeRef.current,
          change.element,
          activeCompPath,
        );
        return {
          change,
          attrs: [
            ["data-start", live?.getAttribute("data-start") ?? null],
            ["data-duration", live?.getAttribute("data-duration") ?? null],
            [playbackAttr, live?.getAttribute(playbackAttr) ?? null],
          ] as Array<[string, string | null]>,
        };
      });
      for (const change of changes) {
        const liveAttrs: Array<[string, string]> = [
          ["data-start", formatTimelineAttributeNumber(change.start)],
          ["data-duration", formatTimelineAttributeNumber(change.duration)],
        ];
        if (change.playbackStart != null) {
          const liveAttr = playbackStartAttributeForElement(change.element);
          liveAttrs.push([liveAttr, formatTimelineAttributeNumber(change.playbackStart)]);
        }
        patchIframeDomTiming(previewIframeRef.current, change.element, liveAttrs, activeCompPath);
      }

      const maxEnd = Math.max(...changes.map((change) => change.start + change.duration));
      // Snapshot the duration BEFORE the optimistic updates below so a failed
      // persist can roll the readout + live root back (see captureDurationRollback).
      const rollbackDuration = captureDurationRollback(previewIframeRef.current);
      // needsExtension gates the SDK path (setTiming can't grow the root duration),
      // so read the store BEFORE the readout sync below optimistically updates it.
      const needsExtension = extendRootDurationIfNeeded(maxEnd);
      // Optimistic duration readout: content-driven (grow AND shrink), read from
      // the just-patched live DOM. See syncPreviewContentDuration.
      syncPreviewContentDuration(previewIframeRef.current);
      const coalesceKey = options?.coalesceKey ?? resizeCoalesceKey(changes);
      const coalesceMs = options?.coalesceMs;
      return enqueueGroupOperation("Resize timeline clips", async (projectId) => {
        await options?.beforeTiming;
        if (nativeAuthoritative) {
          const currentDocument = nativeDocumentRef.current;
          const dependencies = nativeProjectEditing;
          if (!currentDocument || !dependencies) {
            throw new Error("The authoritative native project is no longer available");
          }
          const commitAgainst = (expectedRevision: number) =>
            commitNativeTimelineMultiRangeEdit({
              expectedRevision,
              changes: changes.map((change) => ({
                element: {
                  id: change.element.id,
                  hfId: change.element.hfId,
                  sourceFile: change.element.sourceFile,
                  selector: change.element.selector,
                  selectorIndex: change.element.selectorIndex,
                },
                requestedStartSeconds: change.start,
                requestedDurationSeconds: change.duration,
              })),
              readOptionalProjectFile: dependencies.readOptionalProjectFile,
              writeProjectFile,
              recordEdit,
              commitFileTransaction: dependencies.commitFileTransaction,
              coalesceKey,
              coalesceMs,
              patchCompatibilityContent: (original, edit) => {
                const change = nativeChangeByClipId.get(edit.address.clipId);
                const target = change ? buildPatchTarget(change.element) : null;
                if (!change || !target) return original;
                return buildTimelineResizeTimingPatch(
                  original,
                  target,
                  change.element,
                  {
                    start: Number(edit.timing.start),
                    duration: Number(edit.timing.duration),
                    playbackStart: Number(edit.timing.sourceOffset),
                  },
                  {
                    start: edit.timing.start,
                    duration: edit.timing.duration,
                    playbackStart: edit.timing.sourceOffset,
                  },
                );
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
            throw new Error(`Native timeline group resize was not committed: ${result.reason}`);
          }
          for (const edit of result.edits) {
            const change = nativeChangeByClipId.get(edit.address.clipId);
            if (!change) continue;
            patchIframeDomTiming(
              previewIframeRef.current,
              change.element,
              [
                ["data-start", edit.compatibility.start],
                ["data-duration", edit.compatibility.duration],
                [
                  playbackStartAttributeForElement(change.element),
                  edit.compatibility.sourceOffset,
                ],
              ],
              activeCompPath,
            );
          }
          syncPreviewContentDuration(previewIframeRef.current);
          forceReloadSdkSession?.();
          return;
        }
        const handledBySdk = await trySdkBatchPersist({
          changes,
          sdkChanges: toSdkTimingChanges(changes, (change) => ({
            start: change.start,
            duration: change.duration,
          })),
          eligible: changes.every((change) => !resizeHasPlaybackStartAdjustment(change)),
          needsExtension,
          label: "Resize timeline clips",
          coalesceKey,
          coalesceMs,
        });
        if (!handledBySdk) {
          await persistServerBatch(
            projectId,
            "Resize timeline clips",
            changes.map((change) => ({
              element: change.element,
              buildPatches: (original, target) =>
                buildTimelineResizeTimingPatch(original, target, change.element, {
                  start: change.start,
                  duration: change.duration,
                  playbackStart: change.playbackStart,
                }),
            })),
            coalesceKey,
            coalesceMs,
          );
        }
        // See the move path: the timing persist is already on disk, so the GSAP
        // cache must be invalidated even when the position rewrite throws.
        try {
          await finishGroupTimingGsapFallback({
            projectId,
            iframe: previewIframeRef.current,
            reloadPreview,
            label: "Resize timeline clips",
            errorLabel: "Failed to scale GSAP positions",
            coalesceKey,
            recordEdit,
            activeCompPath,
            changes,
            resolveChangePath: (element) => targetPathFor(element, activeCompPath),
            mutateChange: (change, changePath) => {
              const domId = change.element.domId;
              const timingChanged =
                change.start !== change.element.start ||
                change.duration !== change.element.duration;
              if (!timingChanged || !domId) return null;
              return scaleGsapPositions(
                projectId,
                changePath,
                domId,
                change.element.start,
                change.element.duration,
                change.start,
                change.duration,
              );
            },
          });
        } finally {
          invalidateGsapCache?.();
        }
      }).catch((error) => {
        // Failed persist: revert the optimistic duration readout + live root
        // alongside the gesture owner's store rollback.
        for (const snapshot of liveTimingBefore) {
          patchIframeDomTiming(
            previewIframeRef.current,
            snapshot.change.element,
            snapshot.attrs,
            activeCompPath,
          );
        }
        rollbackDuration();
        showToast(getStudioSaveErrorMessage(error), "error");
        throw error;
      });
    },
    [
      activeCompPath,
      enqueueGroupOperation,
      persistServerBatch,
      previewIframeRef,
      recordEdit,
      reloadPreview,
      trySdkBatchPersist,
      showToast,
      invalidateGsapCache,
      nativeProjectEditing,
      nativeDocumentRef,
      forceReloadSdkSession,
    ],
  );

  return { handleTimelineGroupMove, handleTimelineGroupResize };
}
