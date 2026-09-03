// @vitest-environment happy-dom

import React, { act } from "react";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineElement } from "../../player";
import type { TimelineEditCallbacks } from "../../player/components/timelineCallbacks";
import { timelineKeyframeSelectionKey } from "../../player/components/timelineKeyframeIdentity";
import { usePlayerStore } from "../../player/store/playerStore";
import { installReactActEnvironment, mountReactHarness } from "../../hooks/domSelectionTestHarness";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "../../project/nativeProjectDocument";

installReactActEnvironment();

const mocks = vi.hoisted(() => ({
  actions: {
    handleGsapRemoveKeyframe: vi.fn(),
    handleGsapMoveKeyframeToPlayhead: vi.fn(),
    handleGsapMoveKeyframe: vi.fn().mockResolvedValue(true),
    handleGsapResizeKeyframedTween: vi.fn().mockResolvedValue(true),
    handleGsapUpdateMeta: vi.fn().mockResolvedValue(true),
    handleGsapAddKeyframe: vi.fn(),
    handleGsapAddKeyframeBatch: vi.fn().mockResolvedValue(undefined),
    handleGsapConvertToKeyframes: vi.fn(),
    handleGsapRemoveAllKeyframes: vi.fn().mockResolvedValue(true),
    handleGsapDeleteAnimation: vi.fn(),
    buildDomSelectionForTimelineElement: vi.fn(),
    deleteNativeKeyframe: vi.fn().mockResolvedValue(undefined),
    deleteNativeKeyframes: vi.fn().mockResolvedValue(undefined),
    deleteAllNativeKeyframes: vi.fn().mockResolvedValue(undefined),
    moveNativeKeyframe: vi.fn().mockResolvedValue(undefined),
    moveNativeKeyframes: vi.fn().mockResolvedValue(undefined),
    setNativeKeyframeInterpolation: vi.fn().mockResolvedValue(undefined),
    setNativeKeyframesInterpolation: vi.fn().mockResolvedValue(undefined),
    handleGsapUpdateSegmentEase: vi.fn(),
    handleGsapUpdateKeyframeEase: vi.fn(),
  },
  selection: { id: "box", selector: "#box", sourceFile: "index.html" },
  animations: Array<GsapAnimation>(),
  nativeDocument: null as NativeProjectDocument | null,
}));

vi.mock("../../contexts/StudioContext", () => ({
  useStudioShellContext: () => ({ projectId: "project", activeCompPath: "index.html" }),
}));

vi.mock("../../contexts/DomEditContext", () => ({
  useDomEditActionsContext: () => mocks.actions,
  useDomEditSelectionContext: () => ({
    domEditSelection: mocks.selection,
    selectedGsapAnimations: mocks.animations,
    nativeProjectDocument: mocks.nativeDocument,
  }),
}));

import { useTimelineEditCallbacks } from "./useTimelineEditCallbacks";

const element: TimelineElement = {
  id: "box",
  key: "index.html#box",
  domId: "box",
  tag: "div",
  start: 0,
  duration: 1,
  track: 0,
  sourceFile: "index.html",
};

function nativeDocument(): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:native-timeline",
    revision: 1,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#111111" },
    assets: [{ id: "asset:box", kind: "image", name: "box.png", durationFrames: 300 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [
        {
          id: "track:v1",
          kind: "video",
          clips: [
            {
              id: "clip:box",
              assetId: "asset:box",
              startFrame: 0,
              durationFrames: 120,
              sourceInFrame: 0,
              muted: false,
              effects: [],
              binding: { sourceFile: "index.html", domId: "box" },
              parameterTracks: [],
            },
          ],
        },
      ],
    },
  });
}

const nativeRotationTarget = {
  percentage: 50,
  tweenPercentage: 50,
  propertyGroup: "rotation",
  animationId: "parameter:rotation",
  native: {
    sequenceId: "sequence:main",
    trackId: "track:v1",
    clipId: "clip:box",
    parameterId: "transform.rotation",
    keyframeId: "rotation:60",
    frame: 60,
  },
} as const;

const nativePositionTarget = {
  percentage: 50,
  tweenPercentage: 50,
  propertyGroup: "position",
  native: {
    sequenceId: "sequence:main",
    trackId: "track:v1",
    clipId: "clip:box",
    parameterId: "transform.position.x",
    keyframeId: "position-x:60",
    frame: 60,
  },
  nativeTargets: [
    {
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:box",
      parameterId: "transform.position.x",
      keyframeId: "position-x:60",
      frame: 60,
    },
    {
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:box",
      parameterId: "transform.position.y",
      keyframeId: "position-y:60",
      frame: 60,
    },
  ],
} as const;

const flatAnimation: GsapAnimation = {
  id: "box-to-0-position",
  targetSelector: "#box",
  method: "to",
  position: 0,
  resolvedStart: 0,
  duration: 1,
  properties: { x: 420 },
  propertyGroup: "position",
};

const otherFlatAnimation: GsapAnimation = {
  ...flatAnimation,
  id: "circle-to-0-position",
  targetSelector: "#circle",
};

const otherKeyframedAnimation: GsapAnimation = {
  ...otherFlatAnimation,
  keyframes: {
    format: "percentage",
    keyframes: [
      { percentage: 0, properties: { x: 0 } },
      { percentage: 100, properties: { x: 420 } },
    ],
  },
};

function authoredInteriorAnimation(): GsapAnimation {
  return {
    ...flatAnimation,
    keyframes: {
      format: "percentage",
      keyframes: [
        { percentage: 0, properties: { x: 0 } },
        { percentage: 50, properties: { x: 210 } },
        { percentage: 100, properties: { x: 420 } },
      ],
    },
  };
}

function authoredOpacityAnimation(): GsapAnimation {
  return {
    ...flatAnimation,
    id: "box-to-0-visual",
    properties: { opacity: 1 },
    propertyGroup: "visual",
    keyframes: {
      format: "percentage",
      keyframes: [
        { percentage: 0, properties: { opacity: 0.2 } },
        { percentage: 100, properties: { opacity: 0.8 } },
      ],
    },
  };
}

function authoredRotationAnimation(): GsapAnimation {
  return {
    ...flatAnimation,
    id: "box-to-0-rotation",
    properties: { rotation: 180 },
    propertyGroup: "rotation",
    keyframes: {
      format: "percentage",
      keyframes: [
        { percentage: 0, properties: { rotation: 0 } },
        { percentage: 100, properties: { rotation: 180 } },
      ],
    },
  };
}

function renderCallbacks(): { callbacks: TimelineEditCallbacks; unmount: () => void } {
  let callbacks: TimelineEditCallbacks | null = null;
  function Harness() {
    callbacks = useTimelineEditCallbacks({
      handleTimelineElementMove: vi.fn(),
      handleTimelineElementsMove: vi.fn(),
      handleTimelineElementResize: vi.fn(),
      handleTimelineGroupResize: vi.fn(),
      handleToggleTrackHidden: vi.fn(),
      setAudioGroupAttribute: { setLive: vi.fn(), setQuiet: vi.fn() },
      handleBlockedTimelineEdit: vi.fn(),
      handleTimelineElementSplit: vi.fn(),
      handleRazorSplit: vi.fn(),
      handleRazorSplitAll: vi.fn(),
    });
    return null;
  }
  const root = mountReactHarness(<Harness />);
  if (!callbacks) throw new Error("timeline callbacks did not initialize");
  return { callbacks, unmount: () => act(() => root.unmount()) };
}

// One selection PER element, so a callback that resolves the selection for the
// wrong element gets a visibly different object. A single mockResolvedValue
// hands every element the same selection, which passes just as happily when the
// write is committed through whatever happens to be selected.
function selectionForElement(el: TimelineElement): {
  id: string;
  selector: string;
  sourceFile: string;
} {
  if (el.id === "box") return mocks.selection;
  return { id: el.id, selector: `#${el.id}`, sourceFile: el.sourceFile ?? "index.html" };
}

function arrangeClickedCircle(): {
  circle: TimelineElement;
  selection: { id: string; selector: string; sourceFile: string };
} {
  const elementKey = "scenes/main.html#circle";
  const circle: TimelineElement = {
    ...element,
    id: "circle",
    key: elementKey,
    domId: "circle",
    sourceFile: "scenes/main.html",
  };
  usePlayerStore.setState({
    elements: [element, circle],
    gsapAnimations: new Map([[elementKey, [otherKeyframedAnimation]]]),
  });
  return { circle, selection: selectionForElement(circle) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actions.moveNativeKeyframe.mockResolvedValue(undefined);
  mocks.actions.moveNativeKeyframes.mockResolvedValue(undefined);
  mocks.animations = [flatAnimation];
  mocks.nativeDocument = null;
  mocks.actions.buildDomSelectionForTimelineElement.mockImplementation((el: TimelineElement) =>
    Promise.resolve(selectionForElement(el)),
  );
  usePlayerStore.setState({
    currentTime: 0.5,
    elements: [element],
    domClipChildren: [],
    keyframeCache: new Map(),
    gsapAnimations: new Map([["box", [flatAnimation]]]),
  });
});

afterEach(() => {
  usePlayerStore.setState({
    elements: [],
    domClipChildren: [],
    keyframeCache: new Map(),
    gsapAnimations: new Map(),
  });
});

describe("useTimelineEditCallbacks — native project keyframes", () => {
  it("deletes every scalar represented by a grouped native diamond in one batch", async () => {
    mocks.nativeDocument = nativeDocument();
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onDeleteKeyframe?.(element.key!, nativePositionTarget);
      await Promise.resolve();
    });

    expect(mocks.actions.deleteNativeKeyframes).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ parameterId: "transform.position.x", frame: 60 }),
      expect.objectContaining({ parameterId: "transform.position.y", frame: 60 }),
    ]);
    expect(mocks.actions.deleteNativeKeyframe).not.toHaveBeenCalled();
    view.unmount();
  });

  it("collapses every scalar represented by grouped delete-all in one native command", async () => {
    mocks.nativeDocument = nativeDocument();
    usePlayerStore.setState({ currentTime: 0.5 });
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onDeleteAllKeyframes?.(
        element,
        undefined,
        nativePositionTarget.nativeTargets,
      );
      await Promise.resolve();
    });

    expect(mocks.actions.deleteAllNativeKeyframes).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ parameterId: "transform.position.x", frame: 15 }),
      expect.objectContaining({ parameterId: "transform.position.y", frame: 15 }),
    ]);
    view.unmount();
  });

  it("sets outgoing interpolation for every grouped scalar in one batch", async () => {
    mocks.nativeDocument = nativeDocument();
    const view = renderCallbacks();
    const outgoing = { type: "hold" as const };

    await act(async () => {
      view.callbacks.onSetKeyframeInterpolation?.(element.key!, nativePositionTarget, outgoing);
      await Promise.resolve();
    });

    expect(mocks.actions.setNativeKeyframesInterpolation).toHaveBeenCalledExactlyOnceWith(
      [
        expect.objectContaining({ parameterId: "transform.position.x", frame: 60 }),
        expect.objectContaining({ parameterId: "transform.position.y", frame: 60 }),
      ],
      outgoing,
    );
    expect(mocks.actions.setNativeKeyframeInterpolation).not.toHaveBeenCalled();
    view.unmount();
  });

  it("retimes every grouped scalar in one atomic drag command", async () => {
    mocks.nativeDocument = nativeDocument();
    const view = renderCallbacks();

    let committed = false;
    await act(async () => {
      committed =
        (await view.callbacks.onMoveKeyframe?.(element.key!, nativePositionTarget, 75)) ?? false;
    });

    expect(committed).toBe(true);
    expect(mocks.actions.moveNativeKeyframes).toHaveBeenCalledExactlyOnceWith(
      [
        expect.objectContaining({ parameterId: "transform.position.x", frame: 60 }),
        expect.objectContaining({ parameterId: "transform.position.y", frame: 60 }),
      ],
      90,
    );
    expect(mocks.actions.moveNativeKeyframe).not.toHaveBeenCalled();
    view.unmount();
  });

  it("moves every grouped scalar to the playhead and rekeys the grouped selection only after commit", async () => {
    mocks.nativeDocument = nativeDocument();
    usePlayerStore.setState({ currentTime: 0.5, selectedElementId: element.key! });
    const oldSelection = timelineKeyframeSelectionKey(element.key!, nativePositionTarget);
    usePlayerStore.setState({ selectedKeyframes: new Set([oldSelection]) });
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onMoveKeyframeToPlayhead?.(element, nativePositionTarget);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.actions.moveNativeKeyframes).toHaveBeenCalledExactlyOnceWith(
      [
        expect.objectContaining({ parameterId: "transform.position.x", frame: 60 }),
        expect.objectContaining({ parameterId: "transform.position.y", frame: 60 }),
      ],
      15,
    );
    const selected = [...usePlayerStore.getState().selectedKeyframes];
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('"frame":15');
    expect(selected[0]).toContain("transform.position.y");
    view.unmount();
  });
  it("collapses only the addressed native parameter at the quantized clip-local playhead frame", async () => {
    const document = nativeDocument();
    document.sequence.tracks[0]!.clips[0]!.startFrame = 30;
    mocks.nativeDocument = document;
    usePlayerStore.setState({ currentTime: 2.515 });
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onDeleteAllKeyframes?.(
        element,
        nativeRotationTarget.animationId,
        nativeRotationTarget.native,
      );
      await Promise.resolve();
    });

    expect(mocks.actions.deleteAllNativeKeyframes).toHaveBeenCalledExactlyOnceWith({
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:box",
      parameterId: "transform.rotation",
      frame: 45,
    });
    expect(mocks.actions.handleGsapRemoveAllKeyframes).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does nothing when native delete-all is requested outside the addressed clip", async () => {
    const document = nativeDocument();
    document.sequence.tracks[0]!.clips[0]!.startFrame = 30;
    mocks.nativeDocument = document;
    usePlayerStore.setState({ currentTime: 0.5 });
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onDeleteAllKeyframes?.(
        element,
        nativeRotationTarget.animationId,
        nativeRotationTarget.native,
      );
      await Promise.resolve();
    });

    expect(mocks.actions.deleteAllNativeKeyframes).not.toHaveBeenCalled();
    expect(mocks.actions.handleGsapRemoveAllKeyframes).not.toHaveBeenCalled();
    view.unmount();
  });

  it("sets native outgoing interpolation at the exact diamond address without GSAP", async () => {
    mocks.nativeDocument = nativeDocument();
    const view = renderCallbacks();
    const outgoing = {
      type: "cubic-bezier" as const,
      controlPoints: { x1: 0, y1: 0, x2: 0.58, y2: 1 },
    };

    await act(async () => {
      view.callbacks.onSetKeyframeInterpolation?.(element.key!, nativeRotationTarget, outgoing);
      await Promise.resolve();
    });

    expect(mocks.actions.setNativeKeyframeInterpolation).toHaveBeenCalledWith(
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:box",
        parameterId: "transform.rotation",
        frame: 60,
      },
      outgoing,
    );
    expect(mocks.actions.handleGsapUpdateSegmentEase).not.toHaveBeenCalled();
    expect(mocks.actions.handleGsapUpdateKeyframeEase).not.toHaveBeenCalled();
    view.unmount();
  });

  it("deletes the exact native address without invoking a GSAP mutation", async () => {
    mocks.nativeDocument = nativeDocument();
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onDeleteKeyframe?.(element.key!, nativeRotationTarget);
      await Promise.resolve();
    });

    expect(mocks.actions.deleteNativeKeyframe).toHaveBeenCalledWith({
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:box",
      parameterId: "transform.rotation",
      frame: 60,
    });
    expect(mocks.actions.handleGsapRemoveKeyframe).not.toHaveBeenCalled();
    view.unmount();
  });

  it("retimes a native diamond to the nearest bounded integer clip frame", async () => {
    mocks.nativeDocument = nativeDocument();
    const view = renderCallbacks();

    let committed = false;
    await act(async () => {
      committed =
        (await view.callbacks.onMoveKeyframe?.(element.key!, nativeRotationTarget, 75)) ?? false;
    });

    expect(committed).toBe(true);
    expect(mocks.actions.moveNativeKeyframe).toHaveBeenCalledWith(
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:box",
        parameterId: "transform.rotation",
        frame: 60,
      },
      90,
    );
    expect(mocks.actions.handleGsapMoveKeyframe).not.toHaveBeenCalled();
    view.unmount();
  });

  it("moves a native diamond to the frame-quantized playhead", async () => {
    mocks.nativeDocument = nativeDocument();
    usePlayerStore.setState({ currentTime: 0.5 });
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onMoveKeyframeToPlayhead?.(element, nativeRotationTarget);
      await Promise.resolve();
    });

    expect(mocks.actions.moveNativeKeyframe).toHaveBeenCalledWith(
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:box",
        parameterId: "transform.rotation",
        frame: 60,
      },
      15,
    );
    view.unmount();
  });

  it("rejects a native move-to-playhead outside the clip instead of clamping or falling back", async () => {
    const document = nativeDocument();
    document.sequence.tracks[0]!.clips[0]!.startFrame = 30;
    mocks.nativeDocument = document;
    usePlayerStore.setState({ currentTime: 0.5 });
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onMoveKeyframeToPlayhead?.(element, nativeRotationTarget);
      await Promise.resolve();
    });

    expect(mocks.actions.moveNativeKeyframe).not.toHaveBeenCalled();
    expect(mocks.actions.handleGsapMoveKeyframeToPlayhead).not.toHaveBeenCalled();
    view.unmount();
  });

  it("re-keys native selection only after move-to-playhead persistence succeeds", async () => {
    mocks.nativeDocument = nativeDocument();
    usePlayerStore.setState({ currentTime: 0.5, selectedElementId: element.key! });
    const oldSelection = timelineKeyframeSelectionKey(element.key!, nativeRotationTarget);
    usePlayerStore.setState({ selectedKeyframes: new Set([oldSelection]) });
    let resolveMove!: () => void;
    mocks.actions.moveNativeKeyframe.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveMove = resolve;
      }),
    );
    const view = renderCallbacks();

    act(() => {
      view.callbacks.onMoveKeyframeToPlayhead?.(element, nativeRotationTarget);
    });
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set([oldSelection]));

    await act(async () => {
      resolveMove();
      await Promise.resolve();
      await Promise.resolve();
    });

    const movedTarget = {
      ...nativeRotationTarget,
      percentage: 12.5,
      tweenPercentage: 12.5,
      native: { ...nativeRotationTarget.native, frame: 15 },
    };
    expect(usePlayerStore.getState().selectedKeyframes).toEqual(
      new Set([timelineKeyframeSelectionKey(element.key!, movedTarget)]),
    );
    view.unmount();
  });

  it("preserves native selection when an occupied move-to-playhead destination is rejected", async () => {
    mocks.nativeDocument = nativeDocument();
    usePlayerStore.setState({ currentTime: 0, selectedElementId: element.key! });
    const oldSelection = timelineKeyframeSelectionKey(element.key!, nativeRotationTarget);
    const originalSelection = new Set([oldSelection]);
    usePlayerStore.setState({ selectedKeyframes: originalSelection });
    mocks.actions.moveNativeKeyframe.mockRejectedValueOnce(
      Object.assign(new Error("Project frame 60 is occupied"), {
        failure: { code: "frame-collision" },
      }),
    );
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onMoveKeyframeToPlayhead?.(element, nativeRotationTarget);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(usePlayerStore.getState().selectedKeyframes).toBe(originalSelection);
    expect(mocks.actions.moveNativeKeyframe).toHaveBeenCalledExactlyOnceWith(
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:box",
        parameterId: "transform.rotation",
        frame: 60,
      },
      0,
    );
    expect(mocks.actions.handleGsapMoveKeyframeToPlayhead).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe("useTimelineEditCallbacks — flat tween keyframe lanes", () => {
  it("adds an opacity keyframe at the playhead from the authored visual lane without x", async () => {
    const opacity = authoredOpacityAnimation();
    mocks.animations = [opacity];
    usePlayerStore.setState({ gsapAnimations: new Map([["index.html#box", [opacity]]]) });
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onToggleKeyframeAtPlayhead?.(element);
      await Promise.resolve();
    });

    expect(mocks.actions.handleGsapAddKeyframeBatch).toHaveBeenCalledWith(
      opacity.id,
      50,
      { opacity: 0.5 },
      undefined,
      mocks.selection,
    );
    expect(mocks.actions.handleGsapAddKeyframe).not.toHaveBeenCalled();
    view.unmount();
  });

  it("adds a rotation keyframe at the playhead from the authored rotation lane without x", async () => {
    const rotation = authoredRotationAnimation();
    mocks.animations = [rotation];
    usePlayerStore.setState({ gsapAnimations: new Map([["index.html#box", [rotation]]]) });
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onToggleKeyframeAtPlayhead?.(element);
      await Promise.resolve();
    });

    expect(mocks.actions.handleGsapAddKeyframeBatch).toHaveBeenCalledWith(
      rotation.id,
      50,
      { rotation: 90 },
      undefined,
      mocks.selection,
    );
    expect(mocks.actions.handleGsapAddKeyframe).not.toHaveBeenCalled();
    view.unmount();
  });

  it("removes the exact authored keyframe already at the playhead", async () => {
    const opacity = authoredOpacityAnimation();
    opacity.keyframes?.keyframes.splice(1, 0, {
      percentage: 50,
      properties: { opacity: 0.5 },
    });
    mocks.animations = [opacity];
    usePlayerStore.setState({ gsapAnimations: new Map([["index.html#box", [opacity]]]) });
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onToggleKeyframeAtPlayhead?.(element);
      await Promise.resolve();
    });

    expect(mocks.actions.handleGsapRemoveKeyframe).toHaveBeenCalledWith(
      opacity.id,
      50,
      undefined,
      mocks.selection,
    );
    expect(mocks.actions.handleGsapAddKeyframeBatch).not.toHaveBeenCalled();
    view.unmount();
  });

  it("adds an interior point through the add-keyframe persist boundary", async () => {
    const view = renderCallbacks();

    await act(async () => {
      await view.callbacks.onTogglePropertyGroupKeyframe?.(element, {
        animationId: flatAnimation.id,
        propertyGroup: "position",
        tweenPercentage: 50,
        properties: { x: 210 },
        remove: false,
      });
    });

    expect(mocks.actions.handleGsapAddKeyframeBatch).toHaveBeenCalledWith(
      flatAnimation.id,
      50,
      { x: 210 },
      undefined,
      mocks.selection,
    );
    expect(mocks.actions.handleGsapConvertToKeyframes).not.toHaveBeenCalled();
    view.unmount();
  });

  it("retimes a flat tween's boundary through update-meta, not the keyframe writer", async () => {
    const view = renderCallbacks();

    await expect(
      view.callbacks.onMoveKeyframe?.(
        "box",
        {
          percentage: 0,
          propertyGroup: "position",
          tweenPercentage: 0,
          animationId: flatAnimation.id,
        },
        25,
      ),
    ).resolves.toBe(true);

    // The start boundary moved to 0.25s; the end stays put, so the window is 0.75s.
    expect(mocks.actions.handleGsapUpdateMeta).toHaveBeenCalledWith(
      flatAnimation.id,
      { position: 0.25, duration: 0.75 },
      mocks.selection,
    );
    expect(mocks.actions.handleGsapMoveKeyframe).not.toHaveBeenCalled();
    // resize-keyframed-tween would convert the flat tween to keyframes form.
    expect(mocks.actions.handleGsapResizeKeyframedTween).not.toHaveBeenCalled();
    view.unmount();
  });

  it("reports an unsettled flat-boundary retime as uncommitted", async () => {
    mocks.actions.handleGsapUpdateMeta.mockResolvedValueOnce(false);
    const view = renderCallbacks();

    // The diamond snaps back on `false`. Answering `true` the moment update-meta
    // was dispatched left a rejected boundary drag rendered at its drop position.
    await expect(
      view.callbacks.onMoveKeyframe?.(
        "box",
        {
          percentage: 0,
          propertyGroup: "position",
          tweenPercentage: 0,
          animationId: flatAnimation.id,
        },
        25,
      ),
    ).resolves.toBe(false);
    view.unmount();
  });

  it("refuses a non-selected element flat boundary instead of deleting the tween", async () => {
    const circle: TimelineElement = {
      ...element,
      id: "circle",
      key: "scenes/main.html#circle",
      domId: "circle",
    };
    usePlayerStore.setState({
      elements: [element, circle],
      gsapAnimations: new Map([["scenes/main.html#circle", [otherFlatAnimation]]]),
    });
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onDeleteKeyframe?.("scenes/main.html#circle", {
        percentage: 0,
        propertyGroup: "position",
        tweenPercentage: 0,
        animationId: otherFlatAnimation.id,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Persisted through the CLICKED element's own selection, not the current one,
    // and as a remove-keyframe the writer can refuse — never a whole-tween delete.
    expect(mocks.actions.handleGsapRemoveKeyframe).toHaveBeenCalledWith(
      otherFlatAnimation.id,
      0,
      undefined,
      selectionForElement(circle),
    );
    expect(mocks.actions.handleGsapDeleteAnimation).not.toHaveBeenCalled();
    view.unmount();
  });

  it("removes a non-selected element authored endpoint through the clicked element's selection", async () => {
    const circle: TimelineElement = {
      ...element,
      id: "circle",
      key: "scenes/main.html#circle",
      domId: "circle",
    };
    usePlayerStore.setState({
      elements: [element, circle],
      gsapAnimations: new Map([["index.html#circle", [otherKeyframedAnimation]]]),
    });
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onDeleteKeyframe?.("scenes/main.html#circle", {
        percentage: 100,
        propertyGroup: "position",
        tweenPercentage: 100,
        animationId: otherKeyframedAnimation.id,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.actions.handleGsapRemoveKeyframe).toHaveBeenCalledWith(
      otherKeyframedAnimation.id,
      100,
      undefined,
      selectionForElement(circle),
    );
    expect(mocks.actions.handleGsapDeleteAnimation).not.toHaveBeenCalled();
    view.unmount();
  });

  it("deletes all keyframes through the clicked non-selected element's identity", async () => {
    const circle: TimelineElement = {
      ...element,
      id: "circle",
      key: "scenes/main.html#circle",
      domId: "circle",
      sourceFile: "scenes/main.html",
    };
    const circleSelection = { id: "circle", selector: "#circle", sourceFile: "scenes/main.html" };
    const scaleAnimation: GsapAnimation = {
      ...otherKeyframedAnimation,
      id: "circle-to-0-scale",
      properties: {},
      propertyGroup: "scale",
      keyframes: {
        format: "percentage",
        keyframes: [
          { percentage: 0, properties: { scale: 1 } },
          { percentage: 100, properties: { scale: 2 } },
        ],
      },
    };
    usePlayerStore.setState({
      elements: [element, circle],
      gsapAnimations: new Map([
        ["scenes/main.html#circle", [otherKeyframedAnimation, scaleAnimation]],
      ]),
    });
    mocks.actions.buildDomSelectionForTimelineElement.mockResolvedValue(circleSelection);
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onDeleteAllKeyframes?.(circle, scaleAnimation.id);
      await Promise.resolve();
    });

    expect(mocks.actions.handleGsapRemoveAllKeyframes).toHaveBeenCalledWith(
      scaleAnimation.id,
      circleSelection,
    );
    view.unmount();
  });

  it("deletes all keyframes on every keyframed tween of the layer, not just the first", async () => {
    const opacityAnimation: GsapAnimation = {
      ...otherKeyframedAnimation,
      id: "circle-to-0-visual",
      propertyGroup: "visual",
    };
    const { circle } = arrangeClickedCircle();
    usePlayerStore.setState({
      gsapAnimations: new Map([
        ["scenes/main.html#circle", [otherKeyframedAnimation, opacityAnimation]],
      ]),
    });
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onDeleteAllKeyframes?.(circle);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.actions.handleGsapRemoveAllKeyframes.mock.calls.map((call) => call[0])).toEqual([
      otherKeyframedAnimation.id,
      opacityAnimation.id,
    ]);
    view.unmount();
  });

  it("does not delete a different lane when an explicit animation identity is stale", async () => {
    const { circle } = arrangeClickedCircle();
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onDeleteAllKeyframes?.(circle, "missing-animation-id");
      await Promise.resolve();
    });

    expect(mocks.actions.handleGsapRemoveAllKeyframes).not.toHaveBeenCalled();
    view.unmount();
  });

  it("aborts every mutation when the clicked element resolves no selection", async () => {
    const { circle } = arrangeClickedCircle();
    mocks.actions.buildDomSelectionForTimelineElement.mockResolvedValue(null);
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onDeleteAllKeyframes?.(circle);
      view.callbacks.onMoveKeyframeToPlayhead?.(circle, {
        percentage: 100,
        propertyGroup: "position",
        tweenPercentage: 100,
        animationId: otherKeyframedAnimation.id,
      });
      view.callbacks.onDeleteKeyframe?.("scenes/main.html#circle", {
        percentage: 100,
        propertyGroup: "position",
        tweenPercentage: 100,
        animationId: otherKeyframedAnimation.id,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // No selection for the clicked element means there is nothing safe to write
    // to: falling back to the current selection would edit a different file.
    expect(mocks.actions.handleGsapRemoveAllKeyframes).not.toHaveBeenCalled();
    expect(mocks.actions.handleGsapMoveKeyframeToPlayhead).not.toHaveBeenCalled();
    expect(mocks.actions.handleGsapRemoveKeyframe).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not delete a different keyframe when its explicit animation identity is stale", () => {
    const view = renderCallbacks();

    act(() => {
      view.callbacks.onDeleteKeyframe?.("box", {
        percentage: 100,
        propertyGroup: "position",
        tweenPercentage: 100,
        animationId: "missing-animation-id",
      });
    });

    expect(mocks.actions.handleGsapDeleteAnimation).not.toHaveBeenCalled();
    expect(mocks.actions.handleGsapRemoveKeyframe).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not move a different keyframe when its explicit animation identity is stale", async () => {
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onMoveKeyframeToPlayhead?.(element, {
        percentage: 100,
        propertyGroup: "position",
        tweenPercentage: 100,
        animationId: "missing-animation-id",
      });
      await Promise.resolve();
    });

    expect(mocks.actions.handleGsapMoveKeyframeToPlayhead).not.toHaveBeenCalled();
    view.unmount();
  });

  it("moves a keyframe to the playhead through the clicked non-selected element's identity", async () => {
    const { circle, selection } = arrangeClickedCircle();
    const view = renderCallbacks();

    await act(async () => {
      view.callbacks.onMoveKeyframeToPlayhead?.(circle, {
        percentage: 100,
        propertyGroup: "position",
        tweenPercentage: 100,
        animationId: otherKeyframedAnimation.id,
      });
      await Promise.resolve();
    });

    // The retime target, the selection it commits through, and the animation the
    // playhead percentage is computed against all come from the CLICKED element.
    expect(mocks.actions.handleGsapMoveKeyframeToPlayhead).toHaveBeenCalledWith(
      otherKeyframedAnimation.id,
      100,
      selection,
      otherKeyframedAnimation,
    );
    view.unmount();
  });

  it("keeps a selected-element flat boundary on the remove-keyframe path", () => {
    const view = renderCallbacks();

    act(() => {
      view.callbacks.onDeleteKeyframe?.("box", {
        percentage: 0,
        propertyGroup: "position",
        tweenPercentage: 0,
        animationId: flatAnimation.id,
      });
    });

    expect(mocks.actions.handleGsapRemoveKeyframe).toHaveBeenCalledWith(
      flatAnimation.id,
      0,
      undefined,
      undefined,
    );
    expect(mocks.actions.handleGsapDeleteAnimation).not.toHaveBeenCalled();
    view.unmount();
  });

  it("routes the flat lane-header remove toggle through the refusable remove path", async () => {
    const view = renderCallbacks();

    await act(async () => {
      await view.callbacks.onTogglePropertyGroupKeyframe?.(element, {
        animationId: flatAnimation.id,
        propertyGroup: "position",
        tweenPercentage: 100,
        properties: { x: 420 },
        remove: true,
      });
    });

    expect(mocks.actions.handleGsapRemoveKeyframe).toHaveBeenCalledWith(
      flatAnimation.id,
      100,
      undefined,
      mocks.selection,
    );
    expect(mocks.actions.handleGsapDeleteAnimation).not.toHaveBeenCalled();
    view.unmount();
  });

  // The lane-header toggle fires on whichever element owns the lane, which need
  // not be the selected one. It must still commit through that element's own
  // selection, and it must never escalate a flat tween to a whole-tween delete.
  it("removes a non-selected element's flat tween through that element's own selection", async () => {
    const circle: TimelineElement = {
      ...element,
      id: "circle",
      key: "scenes/main.html#circle",
      domId: "circle",
    };
    usePlayerStore.setState({
      elements: [element, circle],
      gsapAnimations: new Map([["scenes/main.html#circle", [otherFlatAnimation]]]),
    });
    const view = renderCallbacks();

    await act(async () => {
      await view.callbacks.onTogglePropertyGroupKeyframe?.(circle, {
        animationId: otherFlatAnimation.id,
        propertyGroup: "position",
        tweenPercentage: 0,
        properties: { x: 0 },
        remove: true,
      });
    });

    expect(mocks.actions.handleGsapRemoveKeyframe).toHaveBeenCalledWith(
      otherFlatAnimation.id,
      0,
      undefined,
      selectionForElement(circle),
    );
    expect(mocks.actions.handleGsapDeleteAnimation).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps authored interior deletion on the per-keyframe path", () => {
    mocks.animations = [authoredInteriorAnimation()];
    usePlayerStore.setState({ gsapAnimations: new Map([["box", mocks.animations]]) });
    const view = renderCallbacks();

    act(() => {
      view.callbacks.onDeleteKeyframe?.("box", {
        percentage: 50,
        propertyGroup: "position",
        tweenPercentage: 50,
        animationId: flatAnimation.id,
      });
    });

    expect(mocks.actions.handleGsapRemoveKeyframe).toHaveBeenCalledWith(
      flatAnimation.id,
      50,
      undefined,
      undefined,
    );
    expect(mocks.actions.handleGsapDeleteAnimation).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps an authored interior drag on the per-keyframe move path", async () => {
    const authored = authoredInteriorAnimation();
    mocks.animations = [authored];
    usePlayerStore.setState({ gsapAnimations: new Map([["box", [authored]]]) });
    const view = renderCallbacks();

    await expect(
      view.callbacks.onMoveKeyframe?.(
        "box",
        {
          percentage: 50,
          propertyGroup: "position",
          tweenPercentage: 50,
          animationId: authored.id,
        },
        75,
      ),
    ).resolves.toBe(true);

    expect(mocks.actions.handleGsapMoveKeyframe).toHaveBeenCalledWith(
      authored.id,
      50,
      75,
      mocks.selection,
    );
    expect(mocks.actions.handleGsapResizeKeyframedTween).not.toHaveBeenCalled();
    view.unmount();
  });

  it("extends a keyframed tween when its authored end is dragged past the tween window", async () => {
    const authored = {
      ...authoredInteriorAnimation(),
      position: 0.2,
      resolvedStart: 0.2,
      duration: 0.4,
    };
    mocks.animations = [authored];
    usePlayerStore.setState({ gsapAnimations: new Map([["index.html#box", [authored]]]) });
    const view = renderCallbacks();

    // The tween occupies [0.2s, 0.6s] inside the 1s clip. A 0.8s drop remains
    // inside the clip but crosses the tween end, so the authored animation must
    // grow to [0.2s, 0.8s] instead of being sent to the generic keyframe move.
    await expect(
      view.callbacks.onMoveKeyframe?.(
        "index.html#box",
        {
          percentage: 100,
          propertyGroup: "position",
          tweenPercentage: 100,
          animationId: authored.id,
        },
        80,
      ),
    ).resolves.toBe(true);

    expect(mocks.actions.handleGsapResizeKeyframedTween).toHaveBeenCalledWith(
      authored.id,
      0.2,
      0.6,
      [
        { from: 0, to: 0 },
        { from: 50, to: 33.3333333333 },
        { from: 100, to: 100 },
      ],
      mocks.selection,
    );
    expect(mocks.actions.handleGsapMoveKeyframe).not.toHaveBeenCalled();
    view.unmount();
  });

  // A drag starts on whatever diamond the pointer is over, which need not be the
  // selected element. Resolving against the selection would retime the selected
  // element's tween and commit it through the selected element's file.
  it("retimes a non-selected element's keyframe through that element's own selection", async () => {
    const circle: TimelineElement = {
      ...element,
      id: "circle",
      key: "scenes/main.html#circle",
      domId: "circle",
      sourceFile: "scenes/main.html",
    };
    const circleSelection = { id: "circle", selector: "#circle", sourceFile: "scenes/main.html" };
    const circleAnimation = { ...authoredInteriorAnimation(), id: "circle-to-0-position" };
    usePlayerStore.setState({
      elements: [element, circle],
      gsapAnimations: new Map([["scenes/main.html#circle", [circleAnimation]]]),
    });
    mocks.actions.buildDomSelectionForTimelineElement.mockResolvedValue(circleSelection);
    const view = renderCallbacks();

    await act(async () => {
      await view.callbacks.onMoveKeyframe?.(
        "scenes/main.html#circle",
        {
          percentage: 50,
          propertyGroup: "position",
          tweenPercentage: 50,
          animationId: circleAnimation.id,
        },
        75,
      );
    });

    expect(mocks.actions.handleGsapMoveKeyframe).toHaveBeenCalledWith(
      circleAnimation.id,
      50,
      75,
      circleSelection,
    );
    view.unmount();
  });

  // The diamond's rapid-second-retime path reports the PENDING clip-% (where the
  // first drag put the keyframe), which the keyframe cache has not caught up to.
  // TimelineClipDiamonds' own test mocks onMoveKeyframe, so only this one proves
  // the real callback resolves that stale-cache position off the identity fields
  // instead of failing the lookup.
  it("retimes from a pending position the keyframe cache has not caught up to", async () => {
    const authored = authoredInteriorAnimation();
    mocks.animations = [authored];
    usePlayerStore.setState({
      elements: [element],
      gsapAnimations: new Map([["index.html#box", [authored]]]),
      // Still the pre-drag positions: 75% is not in here.
      keyframeCache: new Map([
        [
          "index.html#box",
          {
            format: "percentage" as const,
            keyframes: [
              { percentage: 0, properties: { x: 0 } },
              { percentage: 50, properties: { x: 210 } },
              { percentage: 100, properties: { x: 420 } },
            ],
          },
        ],
      ]),
    });
    const view = renderCallbacks();

    await expect(
      view.callbacks.onMoveKeyframe?.(
        "index.html#box",
        {
          percentage: 75,
          propertyGroup: "position",
          tweenPercentage: 50,
          animationId: authored.id,
        },
        85,
      ),
    ).resolves.toBe(true);
    expect(mocks.actions.handleGsapMoveKeyframe).toHaveBeenCalledWith(
      authored.id,
      50,
      85,
      mocks.selection,
    );

    // Control: the same drag WITHOUT the identity fields falls back to the cache
    // lookup, finds nothing at 75%, and cannot retime.
    mocks.actions.handleGsapMoveKeyframe.mockClear();
    await expect(
      view.callbacks.onMoveKeyframe?.("index.html#box", { percentage: 75 }, 85),
    ).resolves.toBe(false);
    expect(mocks.actions.handleGsapMoveKeyframe).not.toHaveBeenCalled();
    view.unmount();
  });

  it("uses the clip timing basis when retiming a duration-less tween", async () => {
    const durationless = {
      ...authoredInteriorAnimation(),
      position: 3.2,
      resolvedStart: 3.2,
      duration: undefined,
    };
    const wideElement = { ...element, start: 10.94, duration: 16.26 };
    mocks.animations = [durationless];
    usePlayerStore.setState({
      elements: [wideElement],
      gsapAnimations: new Map([["box", [durationless]]]),
    });
    const view = renderCallbacks();

    await expect(
      view.callbacks.onMoveKeyframe?.(
        "box",
        {
          percentage: 19.1,
          propertyGroup: "position",
          tweenPercentage: 50,
          animationId: durationless.id,
        },
        40,
      ),
    ).resolves.toBe(true);

    // The whole point of the clip basis: the drop lands at 10.94 + 0.40 * 16.26 =
    // 17.444s, and the duration-less tween borrows the clip's 16.26s window from
    // its 3.2s start, so 17.444 - 3.2 over 16.26 is 87.601%. Any other basis (a
    // zero-length tween, or the clip's own 0-100 %) produces a different number.
    expect(mocks.actions.handleGsapMoveKeyframe).toHaveBeenCalledWith(
      durationless.id,
      50,
      expect.closeTo(87.601, 3),
      mocks.selection,
    );
    expect(mocks.actions.handleGsapResizeKeyframedTween).not.toHaveBeenCalled();
    view.unmount();
  });
});
