import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { TimelineElement } from "../../player/index";
import { usePlayerStore } from "../../player/index";
import { resolveMediaPreviewUrl } from "../../player/components/thumbnailUtils";
import { desktopRequest } from "../../lib/desktopClient";
import type { RecordEditInput } from "./timelineEditingHelpers";
import type { NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import type { NativeTimelineEditingDependencies } from "./useTimelineEditingTypes";
import { commitNativeTimelineSilenceCut } from "../project/nativeTimelineSilenceCutTransaction";
import { buildAtomicCutIntents, runAtomicCutTransaction } from "./razorSplitTransaction";
import { canSplitElement } from "./timelineElementSplit";
import {
  planSilenceRemoval,
  type SilenceRange,
  type SilenceRemovalPlan,
  type SilenceRemovalSegment,
} from "./removeSilence";

const TIMELINE_SYNC_TIMEOUT_MS = 5_000;
const TIMING_MATCH_EPSILON = 0.025;

interface UseRemoveSilenceOptions {
  projectId: string | null;
  activeCompPath: string | null;
  showToast: (message: string, tone?: "error" | "info") => void;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  observeProjectFileVersion?: (path: string, version: string | null) => void;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  domEditSaveTimestampRef: React.MutableRefObject<number>;
  reloadPreview: () => void;
  forceReloadSdkSession?: () => void;
  isRecordingRef?: React.RefObject<boolean>;
  deleteElements: (
    elements: TimelineElement[],
    options?: { suppressSuccessToast?: boolean },
  ) => Promise<void>;
  moveElement: (
    element: TimelineElement,
    updates: Pick<TimelineElement, "start" | "track">,
  ) => Promise<void>;
  splitElement: (element: TimelineElement, splitTime: number) => Promise<void>;
  isNativeElement: (element: TimelineElement) => boolean;
  snapTimelineTime?: (time: number) => number;
  nativeProjectEditing?: NativeTimelineEditingDependencies;
  nativeDocumentRef?: MutableRefObject<NativeProjectDocument | null>;
  editQueueRef?: MutableRefObject<Promise<unknown>>;
}

interface PlannedElement {
  segment: SilenceRemovalSegment;
  element: TimelineElement;
}

function sameClip(left: TimelineElement, right: TimelineElement): boolean {
  const sameStableId = (left.key ?? left.id) === (right.key ?? right.id);
  const sameSource = left.sourceFile === right.sourceFile;
  return (
    sameSource &&
    (sameStableId ||
      (!!left.hfId && left.hfId === right.hfId) ||
      (!!left.domId && left.domId === right.domId))
  );
}

export function sameSilenceSegment(
  element: TimelineElement,
  segment: SilenceRemovalSegment,
  original: TimelineElement,
): boolean {
  return (
    element.tag.toLowerCase() === original.tag.toLowerCase() &&
    element.track === original.track &&
    element.sourceFile === original.sourceFile &&
    element.src === original.src &&
    Math.abs((element.playbackRate ?? 1) - (original.playbackRate ?? 1)) < 1e-6 &&
    Math.abs((element.playbackStart ?? 0) - ((original.playbackStart ?? 0) +
      (segment.start - original.start) * (original.playbackRate ?? 1))) <=
      TIMING_MATCH_EPSILON * (original.playbackRate ?? 1) &&
    Math.abs(element.start - segment.start) <= TIMING_MATCH_EPSILON &&
    Math.abs(element.duration - (segment.end - segment.start)) <= TIMING_MATCH_EPSILON
  );
}

function collectPlannedElements(
  elements: readonly TimelineElement[],
  plan: SilenceRemovalPlan,
  original: TimelineElement,
): PlannedElement[] | null {
  const used = new Set<string>();
  const result: PlannedElement[] = [];
  for (const segment of plan.segments) {
    const candidates = elements.filter(
      (candidate) =>
        !used.has(candidate.key ?? candidate.id) &&
        sameSilenceSegment(candidate, segment, original),
    );
    const element = candidates.length === 1 ? candidates[0] : null;
    if (!element) return null;
    used.add(element.key ?? element.id);
    result.push({ segment, element });
  }
  return result;
}

function waitForTimeline<T>(
  getElements: () => TimelineElement[],
  resolve: (elements: TimelineElement[]) => T | null,
): Promise<T> {
  const immediate = resolve(getElements());
  if (immediate !== null) return Promise.resolve(immediate);

  return new Promise((accept, reject) => {
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timeline did not synchronize after the edit."));
    }, TIMELINE_SYNC_TIMEOUT_MS);
    const check = () => {
      const result = resolve(getElements());
      if (result === null) return;
      clearTimeout(timeout);
      unsubscribe();
      accept(result);
    };
    unsubscribe = usePlayerStore.subscribe(check);
    check();
  });
}

async function analyzeMediaSilence(
  src: string, projectId: string, sourceStart: number, sourceDuration: number, signal: AbortSignal,
): Promise<SilenceRange[]> {
  const url = new URL(resolveMediaPreviewUrl(src, projectId, window.location.href), window.location.href);
  const prefix = `/api/projects/${encodeURIComponent(projectId)}/preview/`;
  if (url.protocol !== window.location.protocol || url.host !== window.location.host ||
      !url.pathname.startsWith(prefix)) {
    throw new Error("Silence removal requires imported project audio or video");
  }
  const source = decodeURIComponent(url.pathname.slice(prefix.length));
  const response = await desktopRequest(`/api/projects/${encodeURIComponent(projectId)}/media/silences`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, sourceStart, sourceDuration }),
  });
  const result = await response.json().catch(() => null) as { ranges?: SilenceRange[]; error?: string } | null;
  if (!response.ok || !Array.isArray(result?.ranges)) {
    throw new Error(result?.error ?? `Could not analyze media audio (${response.status})`);
  }
  return result.ranges;
}

export function useRemoveSilence({
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
  deleteElements,
  moveElement,
  splitElement,
  isNativeElement,
  snapTimelineTime,
  nativeProjectEditing,
  nativeDocumentRef,
  editQueueRef,
}: UseRemoveSilenceOptions) {
  const [isRemovingSilence, setIsRemovingSilence] = useState(false);
  const isRunningRef = useRef(false);
  const projectIdRef = useRef(projectId);
  const activeCompPathRef = useRef(activeCompPath);
  activeCompPathRef.current = activeCompPath;
  const mountedRef = useRef(true);
  const analysisAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; analysisAbortRef.current?.abort(); };
  }, [projectId, activeCompPath]);
  const deleteElementsRef = useRef(deleteElements);
  const moveElementRef = useRef(moveElement);
  projectIdRef.current = projectId;
  deleteElementsRef.current = deleteElements;
  moveElementRef.current = moveElement;

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

  const getElements = useCallback(() => usePlayerStore.getState().elements, []);

  const handleRemoveSilence = useCallback(
    async (selectedElement: TimelineElement) => {
      if (isRunningRef.current) return;
      isRunningRef.current = true;
      setIsRemovingSilence(true);
      try {
        if (isRecordingRef?.current) throw new Error("Cannot edit timeline while recording");
        const pid = projectIdRef.current;
        if (!pid) throw new Error("No active project");
        const composition = activeCompPathRef.current;
        const assertCurrentProject = () => {
          if (!mountedRef.current || projectIdRef.current !== pid || activeCompPathRef.current !== composition) {
            throw new Error("Project changed during silence removal. No further edits were applied.");
          }
          if (isRecordingRef?.current) throw new Error("Cannot edit timeline while recording");
        };
        const original = getElements().find((element) => sameClip(element, selectedElement));
        const tag = original?.tag.toLowerCase();
        if (!original || !original.src || (tag !== "video" && tag !== "audio")) {
          throw new Error("Select an audio or video clip with a media source");
        }
        if (!canSplitElement(original)) throw new Error("This media clip cannot be edited");

        const sourceStart = original.playbackStart ?? 0;
        const rate = original.playbackRate ?? 1;
        const analysisAbort = new AbortController();
        analysisAbortRef.current = analysisAbort;
        const silenceRanges = await analyzeMediaSilence(
          original.src, pid, sourceStart, original.duration * rate, analysisAbort.signal,
        );
        analysisAbortRef.current = null;

        assertCurrentProject();
        const liveOriginal = getElements().find(element => (element.key ?? element.id) === (original.key ?? original.id));
        if (!liveOriginal || liveOriginal.start !== original.start || liveOriginal.duration !== original.duration ||
          liveOriginal.src !== original.src || liveOriginal.playbackStart !== original.playbackStart ||
          liveOriginal.playbackRate !== original.playbackRate || liveOriginal.track !== original.track) {
          throw new Error("The selected clip changed during analysis. Run silence removal again.");
        }
        const snap = isNativeElement(original) ? snapTimelineTime : undefined;
        const ranges = snap ? silenceRanges.map(range => ({
          start: sourceStart + (snap(original.start + (range.start - sourceStart) / rate) - original.start) * rate,
          end: sourceStart + (snap(original.start + (range.end - sourceStart) / rate) - original.start) * rate,
        })) : silenceRanges;
        const plan = planSilenceRemoval(original, ranges);
        if (plan.removedRanges.length === 0) {
          showToast("No silence found in the selected clip.", "info");
          return;
        }

        if (isNativeElement(original)) {
          if (!nativeProjectEditing || !nativeDocumentRef?.current || !editQueueRef) {
            throw new Error("The authoritative native project is unavailable");
          }
          const controller = new AbortController();
          analysisAbortRef.current = controller;
          const operation = editQueueRef.current.then(async () => {
            assertCurrentProject();
            return commitNativeTimelineSilenceCut({
              expectedRevision: nativeDocumentRef.current!.revision,
              element: {
                id: original.id, hfId: original.hfId,
                sourceFile: original.sourceFile, selector: original.selector,
                selectorIndex: original.selectorIndex,
              },
              playbackElement: original,
              plan,
              readOptionalProjectFile: nativeProjectEditing.readOptionalProjectFile,
              writeProjectFile,
              recordEdit,
              commitFileTransaction: nativeProjectEditing.commitFileTransaction,
              signal: controller.signal,
              onCommitted: (document) => {
                if (!mountedRef.current || projectIdRef.current !== pid) return;
                nativeDocumentRef.current = document;
                nativeProjectEditing.onNativeDocumentCommitted(document);
              },
            });
          });
          editQueueRef.current = operation.then(() => undefined, () => undefined);
          await operation;
          analysisAbortRef.current = null;
          domEditSaveTimestampRef.current = Date.now();
          synchronize();
          showToast(
            `Removed ${plan.removedRanges.length} silences, ${plan.removedSeconds.toFixed(1)}s`,
            "info",
          );
          return;
        }

        const skippedSelectors = new Set<string>();
        for (const splitTime of [...plan.cutTimes].sort((left, right) => right - left)) {
          assertCurrentProject();
          const current = getElements().find((element) => sameClip(element, original));
          if (!current) throw new Error("The selected clip disappeared during silence removal.");
          const expectedDuration = splitTime - current.start;
          if (expectedDuration <= 0 || expectedDuration >= current.duration) continue;
          domEditSaveTimestampRef.current = Date.now();
          if (isNativeElement(current)) {
            await splitElement(current, splitTime);
          } else {
            const shortenedElement = { ...current, duration: expectedDuration };
            const result = await runAtomicCutTransaction({
              projectId: pid,
              intents: buildAtomicCutIntents([shortenedElement], splitTime, activeCompPath),
              label: "Remove silence: split clip",
              writeProjectFile,
              recordEdit,
              observeProjectFileVersion,
              synchronize,
            });
            if (result.syncFailed) {
              throw new Error("Clip was split, but Studio could not refresh the timeline.");
            }
            for (const selector of result.skippedSelectors) skippedSelectors.add(selector);
          }
          await waitForTimeline(getElements, (elements) => {
            const updated = elements.find((element) => sameClip(element, original));
            return updated && Math.abs(updated.duration - expectedDuration) <= TIMING_MATCH_EPSILON
              ? updated
              : null;
          });
        }

        const planned = await waitForTimeline(getElements, (elements) =>
          collectPlannedElements(elements, plan, original),
        );
        const silentElements = planned
          .filter(({ segment }) => segment.remove)
          .map(({ element }) => element);
        assertCurrentProject();
        // The compound action reports its own result after the delete and
        // subsequent moves finish. Keep delete failures visible.
        await deleteElementsRef.current(silentElements, { suppressSuccessToast: true });
        await waitForTimeline(getElements, (elements) =>
          silentElements.every(
            (silent) => !elements.some((element) => sameClip(element, silent)),
          )
            ? true
            : null,
        );

        let nextStart = original.start;
        for (const { segment } of planned) {
          assertCurrentProject();
          if (segment.remove) continue;
          const liveElement = getElements().find((element) =>
            sameSilenceSegment(element, segment, original),
          );
          if (!liveElement) throw new Error("A kept clip piece disappeared during silence removal.");
          if (Math.abs(liveElement.start - nextStart) > TIMING_MATCH_EPSILON) {
            await moveElementRef.current(liveElement, {
              start: nextStart,
              track: liveElement.track,
            });
          }
          nextStart += segment.end - segment.start;
        }

        domEditSaveTimestampRef.current = Date.now();
        showToast(
          `Removed ${plan.removedRanges.length} silences, ${plan.removedSeconds.toFixed(1)}s`,
          "info",
        );
        if (skippedSelectors.size > 0) {
          showToast(
            `Some animations use non-ID selectors (${[...skippedSelectors].join(", ")}) and were not retargeted`,
            "info",
          );
        }
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : "Failed to remove silence",
          "error",
        );
      } finally {
        analysisAbortRef.current?.abort();
        analysisAbortRef.current = null;
        isRunningRef.current = false;
        if (mountedRef.current) setIsRemovingSilence(false);
      }
    },
    [
      activeCompPath,
      domEditSaveTimestampRef,
      getElements,
      isNativeElement,
      isRecordingRef,
      nativeProjectEditing,
      nativeDocumentRef,
      editQueueRef,
      observeProjectFileVersion,
      recordEdit,
      showToast,
      splitElement,
      snapTimelineTime,
      synchronize,
      writeProjectFile,
    ],
  );

  return { handleRemoveSilence, isRemovingSilence };
}
