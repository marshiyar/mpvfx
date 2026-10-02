import { useCallback, useRef, useState } from "react";
import type { TimelineElement } from "../../player/index";
import { usePlayerStore } from "../../player/index";
import { resolveMediaPreviewUrl } from "../../player/components/thumbnailUtils";
import { desktopRequest } from "../../lib/desktopClient";
import type { RecordEditInput } from "./timelineEditingHelpers";
import { buildAtomicCutIntents, runAtomicCutTransaction } from "./razorSplitTransaction";
import { canSplitElement } from "./timelineElementSplit";
import {
  DEFAULT_SILENCE_REMOVAL_OPTIONS,
  detectSilences,
  planSilenceRemoval,
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
  deleteElements: (elements: TimelineElement[]) => Promise<void>;
  moveElement: (
    element: TimelineElement,
    updates: Pick<TimelineElement, "start" | "track">,
  ) => Promise<void>;
  splitElement: (element: TimelineElement, splitTime: number) => Promise<void>;
  isNativeElement: (element: TimelineElement) => boolean;
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

function sameSegment(
  element: TimelineElement,
  segment: SilenceRemovalSegment,
  original: TimelineElement,
): boolean {
  return (
    element.tag.toLowerCase() === "video" &&
    element.track === original.track &&
    element.sourceFile === original.sourceFile &&
    element.src === original.src &&
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
    const element = elements.find(
      (candidate) =>
        !used.has(candidate.key ?? candidate.id) &&
        sameSegment(candidate, segment, original),
    );
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

async function loadMediaBytes(src: string, projectId: string): Promise<ArrayBuffer> {
  const url = resolveMediaPreviewUrl(src, projectId, window.location.href);
  const response = new URL(url, window.location.href).protocol === "mpvfx:"
    ? await desktopRequest(url)
    : await fetch(url);
  if (!response.ok) throw new Error(`Could not load clip media (${response.status})`);
  return response.arrayBuffer();
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
}: UseRemoveSilenceOptions) {
  const [isRemovingSilence, setIsRemovingSilence] = useState(false);
  const isRunningRef = useRef(false);
  const projectIdRef = useRef(projectId);
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
        const original = getElements().find((element) => sameClip(element, selectedElement));
        if (!original || !original.src || original.tag.toLowerCase() !== "video") {
          throw new Error("Select a video clip with a media source");
        }
        if (!canSplitElement(original)) throw new Error("This video clip cannot be edited");

        const bytes = await loadMediaBytes(original.src, pid);
        const audioContext = new AudioContext();
        let silenceRanges;
        try {
          const audio = await audioContext.decodeAudioData(bytes.slice(0));
          const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
            audio.getChannelData(index),
          );
          silenceRanges = detectSilences(
            channels,
            audio.sampleRate,
            DEFAULT_SILENCE_REMOVAL_OPTIONS,
          );
        } finally {
          void audioContext.close();
        }

        const plan = planSilenceRemoval(original, silenceRanges);
        if (plan.removedRanges.length === 0) {
          showToast("No silence found in the selected clip.", "info");
          return;
        }

        const skippedSelectors = new Set<string>();
        for (const splitTime of [...plan.cutTimes].sort((left, right) => right - left)) {
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
        await deleteElementsRef.current(silentElements);
        await waitForTimeline(getElements, (elements) =>
          silentElements.every(
            (silent) => !elements.some((element) => sameClip(element, silent)),
          )
            ? true
            : null,
        );

        let nextStart = original.start;
        for (const { segment } of planned) {
          if (segment.remove) continue;
          const liveElement = getElements().find((element) =>
            sameSegment(element, segment, original),
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
        isRunningRef.current = false;
        setIsRemovingSilence(false);
      }
    },
    [
      activeCompPath,
      domEditSaveTimestampRef,
      getElements,
      isNativeElement,
      isRecordingRef,
      observeProjectFileVersion,
      recordEdit,
      showToast,
      splitElement,
      synchronize,
      writeProjectFile,
    ],
  );

  return { handleRemoveSilence, isRemovingSilence };
}