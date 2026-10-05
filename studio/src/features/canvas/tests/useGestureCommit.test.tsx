// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "../domEditing";
import { usePlayerStore } from "../../../player/index";
import { mountReactHarness } from "../domSelectionTestHarness";
import type { CommitMutationOptions } from "../../animation/GSAP/gsapScriptCommitTypes";
import { useGestureCommit } from "../useGestureCommit";

const gestureRecording = vi.hoisted(() => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn(() => [
    { time: 0, properties: { x: 0, y: 0, opacity: 1 } },
    { time: 0.5, properties: { x: 50, y: 25, opacity: 0.5 } },
    { time: 1, properties: { x: 100, y: 50, opacity: 0 } },
  ]),
  clearSamples: vi.fn(),
  cancelRecording: vi.fn(),
  isRecording: false,
  recordingDuration: 0,
  samplesRef: { current: [] },
  trailRef: { current: [] },
}));

vi.mock("../useGestureRecording", () => ({
  useGestureRecording: () => gestureRecording,
}));

vi.mock("../rdpSimplify", () => ({
  simplifyGestureSamples: () =>
    new Map([
      [0, { x: 0, y: 0, opacity: 1 }],
      [50, { x: 50, y: 25, opacity: 0.5 }],
      [100, { x: 100, y: 50, opacity: 0 }],
    ]),
}));

vi.mock("../gestureSmoother", () => ({
  smoothGestureKeyframes: (keyframes: unknown) => keyframes,
}));

vi.mock("../velocityEaseFitter", () => ({
  fitEasesFromVelocity: (keyframes: unknown) => keyframes,
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  usePlayerStore.getState().reset();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function makeSelection(element: HTMLElement): DomEditSelection {
  return {
    id: element.id,
    element,
    label: "Card",
    tagName: "div",
    sourceFile: "index.html",
    compositionPath: "index.html",
    isCompositionHost: false,
    isInsideLockedComposition: false,
    boundingBox: { x: 0, y: 0, width: 100, height: 100 },
    textContent: null,
    dataAttributes: { start: "0", duration: "2" },
    inlineStyles: {},
    computedStyles: {},
    textFields: [],
    capabilities: {
      canSelect: true,
      canEditStyles: true,
      canCrop: true,
      canMove: true,
      canResize: true,
      canApplyManualOffset: true,
      canApplyManualSize: true,
      canApplyManualRotation: true,
    },
  };
}

describe("useGestureCommit", () => {
  it.each([false, true])("handles recording completion with project changed=%s", async (changeProject) => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const element = document.createElement("div");
    element.id = "card";
    const commitMutation = vi.fn<
      (mutation: Record<string, unknown>, options: CommitMutationOptions) => Promise<void>
    >(async () => {});
    const sessionRef = {
      current: {
        domEditSelection: makeSelection(element),
        nativeProjectDocument: {
          schemaVersion: 1, id: "project", revision: 0, frameRate: { numerator: 30, denominator: 1 },
          canvas: { width: 100, height: 100, background: "#000000" },
          assets: [{ id: "asset", kind: "image", name: "card", durationFrames: 300 }],
          sequence: { id: "sequence", name: "Main", tracks: [{ id: "track", kind: "video", clips: [{
            id: "clip", assetId: "asset", startFrame: 0, durationFrames: 60, sourceInFrame: 0,
            muted: false, effects: [], parameterTracks: [], binding: { domId: "card", sourceFile: "index.html" },
          }] }] },
        } as import("../../../../shared/project/nativeProjectDocument").NativeProjectDocument,
        commitNativeProject: vi.fn(async () => true),
      },
    };
    const captured: { hook: ReturnType<typeof useGestureCommit> | null } = { hook: null };
    function Probe() {
      captured.hook = useGestureCommit({
        domEditSessionRef: sessionRef,
        previewIframeRef: { current: iframe },
        showToast: vi.fn(),
        isGestureRecordingRef: { current: false },
      });
      return null;
    }
    const root = mountReactHarness(<Probe />);
    cleanup = () => act(() => root.unmount());
    if (!captured.hook) throw new Error("hook did not initialize");

    act(() => captured.hook?.handleToggleRecording());
    if (changeProject) {
      sessionRef.current = { ...sessionRef.current,
        nativeProjectDocument: { ...sessionRef.current.nativeProjectDocument, id: "other-project" } };
      usePlayerStore.setState({ currentTime: 0.75, isPlaying: true });
    }
    act(() => captured.hook?.handleToggleRecording());
    if (changeProject) {
      expect(sessionRef.current.commitNativeProject).not.toHaveBeenCalled();
      expect(usePlayerStore.getState().currentTime).toBe(0.75);
      expect(usePlayerStore.getState().isPlaying).toBe(true);
      expect(gestureRecording.clearSamples).toHaveBeenCalledOnce();
      expect(captured.hook.gestureState).toBe("idle");
      return;
    }
    await act(async () => {
      await vi.waitFor(() => expect(sessionRef.current.commitNativeProject).toHaveBeenCalledTimes(1));
    });

    expect(commitMutation).not.toHaveBeenCalled();
    const saved = (sessionRef.current.commitNativeProject.mock.calls[0] as unknown as [{ document: import("../../../../shared/project/nativeProjectDocument").NativeProjectDocument }])[0].document;
    expect(saved.sequence.tracks[0]!.clips[0]!.parameterTracks).toHaveLength(3);
  });
});
