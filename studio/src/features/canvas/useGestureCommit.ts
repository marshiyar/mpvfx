/**
 * Manages gesture recording state and commit logic for the Studio.
 * Extracted from App.tsx to keep file sizes under the 600-line limit.
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { useGestureRecording } from "./useGestureRecording";
import { simplifyGestureSamples } from "./rdpSimplify";
import { fitEasesFromVelocity } from "./velocityEaseFitter";
import { smoothGestureKeyframes } from "./gestureSmoother";
import { usePlayerStore } from "../../player/index";
import type { DomEditSelection } from "./domEditing";
import { projectNativeKeyframeUi } from "../../../shared/project/nativeKeyframeUiProjection";
import type { NativeSelectedElementReference } from "../../../shared/project/nativePropertyEditPlan";
import type { NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { applyNativeGestureRecording } from "../../../shared/project/nativeGestureRecording";
import type { NativeKeyframeProjectCommit } from "../../player/components/deleteSelectedKeyframes";

interface GestureSessionRef {
  domEditSelection: DomEditSelection | null;
  nativeProjectDocument?: NativeProjectDocument | null;
  commitNativeProject?: (commit: NativeKeyframeProjectCommit) => Promise<boolean>;
}

interface UseGestureCommitParams {
  domEditSessionRef: React.MutableRefObject<GestureSessionRef>;
  previewIframeRef: React.RefObject<HTMLIFrameElement | null>;
  showToast: (message: string, tone?: "error" | "info") => void;
  isGestureRecordingRef: React.MutableRefObject<boolean>;
}

export interface UseGestureCommitResult {
  gestureState: "idle" | "recording";
  gestureRecording: ReturnType<typeof useGestureRecording>;
  handleToggleRecording: () => void;
}

// fallow-ignore-next-line complexity
export function useGestureCommit({
  domEditSessionRef,
  previewIframeRef,
  showToast,
  isGestureRecordingRef,
}: UseGestureCommitParams): UseGestureCommitResult {
  const gestureRecording = useGestureRecording();
  const [gestureState, setGestureState] = useState<"idle" | "recording">("idle");
  const gestureStateRef = useRef<"idle" | "recording">("idle");
  const recordingAutoStopRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const recordingStartTimeRef = useRef(0);
  const commitInFlightRef = useRef(false);
  // Capture selection at recording start so commit always targets the recorded element,
  // even if the user's selection changes mid-recording.
  const capturedSelectionRef = useRef<DomEditSelection | null>(null);
  const capturedSessionRef = useRef<GestureSessionRef | null>(null);
  const capturedTargetRef = useRef<NativeSelectedElementReference>({});

  // Unmount: clear auto-stop interval
  useEffect(() => () => clearInterval(recordingAutoStopRef.current), []);

  // fallow-ignore-next-line complexity
  const stopAndCommitRecording = useCallback(async () => {
    clearInterval(recordingAutoStopRef.current);
    if (commitInFlightRef.current) {
      return;
    }
    commitInFlightRef.current = true;
    gestureStateRef.current = "idle";
    isGestureRecordingRef.current = false;
    const frozenSamples = gestureRecording.stopRecording();
    const store = usePlayerStore.getState();
    const recordedProjectId = capturedSessionRef.current?.nativeProjectDocument?.id;
    const isRecordedProjectActive = () => recordedProjectId !== undefined &&
      domEditSessionRef.current.nativeProjectDocument?.id === recordedProjectId;
    try {
      if (!isRecordedProjectActive()) {
        showToast("Recording cancelled because the active project changed", "info");
        return;
      }
      store.setIsPlaying(false);
      const liveSession = domEditSessionRef.current;
      const sel = capturedSelectionRef.current;
      if (!sel) {
        if (frozenSamples.length > 2) {
          showToast("Selection lost during recording", "error");
        }
        return;
      }
      const duration =
        frozenSamples.length > 0 ? (frozenSamples[frozenSamples.length - 1]?.time ?? 0) : 0;

      if (frozenSamples.length <= 2) {
        showToast("No gesture detected — move the pointer while recording", "error");
        return;
      }
      if (duration <= 0) {
        showToast("Recording too short — try again", "error");
        return;
      }

      // Per-property epsilon: small-range properties (opacity 0–1, scale ~0.01–10)
      // need a much tighter tolerance than positional properties (x/y in px).
      // fallow-ignore-next-line complexity
      const simplified = simplifyGestureSamples(frozenSamples, duration, (key) => {
        if (key === "opacity") return 0.01;
        if (key === "scale" || key === "scaleX" || key === "scaleY") return 0.01;
        return 5;
      });
      const sortedPcts = Array.from(simplified.keys()).sort((a, b) => a - b);

      // Ensure a 0% keyframe exists with the element's start-of-recording position
      if (!simplified.has(0) && frozenSamples.length > 0) {
        simplified.set(0, frozenSamples[0]!.properties);
        if (!sortedPcts.includes(0)) sortedPcts.unshift(0);
      }

      const captured = capturedSessionRef.current;
      const document = captured?.nativeProjectDocument;
      if (!document || !captured.commitNativeProject || liveSession.nativeProjectDocument?.id !== document.id)
        throw new Error("The recording's native project is no longer available");
      const rawKeyframes = sortedPcts.map(percentage => ({ percentage, properties: simplified.get(percentage)! }));
      const keyframes = fitEasesFromVelocity(smoothGestureKeyframes(rawKeyframes, 3), frozenSamples, duration);
      const edited = applyNativeGestureRecording(document, {
        selectedElement: capturedTargetRef.current,
        selectionBounds: sel.boundingBox,
        playheadSeconds: recordingStartTimeRef.current,
      }, duration, keyframes);
      const saved = await captured.commitNativeProject({ document: edited,
        inverse: { type: "restore-document", document }, label: "Gesture recording" });
      if (!saved) throw new Error("The recording could not be saved; the project may have changed during recording");
      showToast(`Recorded ${sortedPcts.length} keyframes`, "info");
    } catch (err) {
      console.error("[GR:error]", err);
      showToast(`Gesture commit failed: ${err}`, "error");
    } finally {
      if (isRecordedProjectActive()) store.requestSeek(recordingStartTimeRef.current);
      gestureRecording.clearSamples();
      setGestureState("idle");
      commitInFlightRef.current = false;
    }
  }, [gestureRecording, showToast, isGestureRecordingRef, domEditSessionRef]);

  // fallow-ignore-next-line complexity
  const handleToggleRecording = useCallback(() => {
    if (commitInFlightRef.current) {
      showToast("Wait for the current recording to finish saving", "info");
      return;
    }
    if (gestureStateRef.current === "recording") {
      void stopAndCommitRecording();
      return;
    }
    const sel = domEditSessionRef.current.domEditSelection;
    if (!sel) {
      showToast("Select an element first", "error");
      return;
    }
    if (!domEditSessionRef.current.nativeProjectDocument || !domEditSessionRef.current.commitNativeProject) {
      showToast("Native keyframing is not ready for this recording", "error");
      return;
    }
    capturedSessionRef.current = { ...domEditSessionRef.current };
    const iframe = previewIframeRef.current;
    if (!iframe) {
      showToast("Preview not ready — try again", "error");
      return;
    }

    const store = usePlayerStore.getState();
    recordingStartTimeRef.current = store.currentTime;
    const elStart = Number.parseFloat(sel.dataAttributes?.start ?? "0") || 0;
    const elDur = Number.parseFloat(sel.dataAttributes?.duration ?? "0") || 0;
    const elementEnd = elDur > 0 ? elStart + elDur : undefined;
    capturedSelectionRef.current = { ...sel, boundingBox: { ...sel.boundingBox } };
    capturedTargetRef.current = { id: sel.id, hfId: sel.hfId, sourceFile: sel.sourceFile,
      selector: sel.selector, selectorIndex: sel.selectorIndex,
      attributes: { "data-studio-clip-id": sel.element.getAttribute("data-studio-clip-id") } };
    const projection = projectNativeKeyframeUi(domEditSessionRef.current.nativeProjectDocument!, {
      selectedElement: capturedTargetRef.current, playheadSeconds: store.currentTime,
    });
    if (!projection.ok) {
      showToast("This layer is not available for native gesture recording", "error");
      return;
    }
    gestureRecording.startRecording(sel.element, iframe, elementEnd, projection.currentValues);
    gestureStateRef.current = "recording";
    isGestureRecordingRef.current = true;
    setGestureState("recording");

    clearInterval(recordingAutoStopRef.current);
    const autoStopAt = elementEnd ?? Infinity;
    recordingAutoStopRef.current = setInterval(() => {
      const { currentTime: t, duration: d } = usePlayerStore.getState();
      const limit = Math.min(autoStopAt, d);
      if (limit > 0 && t >= limit - 0.05) {
        void stopAndCommitRecording();
      }
    }, 100);
  }, [
    gestureRecording,
    showToast,
    stopAndCommitRecording,
    previewIframeRef,
    domEditSessionRef,
    isGestureRecordingRef,
  ]);

  return { gestureState, gestureRecording, handleToggleRecording };
}
