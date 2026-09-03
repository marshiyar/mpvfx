// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineElement } from "../store/playerStore";
import { usePlayerStore } from "../store/playerStore";
import { type KeyframeDiamondContextMenuState } from "./KeyframeDiamondContextMenu";
import { TimelineOverlays, resolveTimelineContextElement } from "./TimelineOverlays";
import { defaultTimelineTheme } from "./timelineTheme";

const { copyTextToClipboard } = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../../utils/clipboard", () => ({ copyTextToClipboard }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  usePlayerStore.setState({
    selectedElementId: null,
    timelineSessionEpoch: 0,
    keyframeCache: new Map(),
  });
  copyTextToClipboard.mockClear();
});

const captured: TimelineElement = {
  id: "child",
  key: "parent::child",
  tag: "div",
  start: 1,
  duration: 2,
  track: 3,
};

describe("resolveTimelineContextElement", () => {
  it("returns the current expanded model instead of the captured snapshot", () => {
    const current = { ...captured, start: 4, track: 7 };

    expect(
      resolveTimelineContextElement({
        capturedElement: captured,
        targetSessionEpoch: 2,
        sessionEpoch: 2,
        selectedElementId: "parent::child",
        elements: [current],
      }),
    ).toBe(current);
  });

  it("resolves synthetic expanded children that are absent from raw store elements", () => {
    expect(
      resolveTimelineContextElement({
        capturedElement: captured,
        targetSessionEpoch: 2,
        sessionEpoch: 2,
        selectedElementId: "parent::child",
        elements: [captured],
      }),
    ).toBe(captured);
  });

  it("rejects stale sessions, changed selection, and removed elements", () => {
    const input = {
      capturedElement: captured,
      targetSessionEpoch: 2,
      sessionEpoch: 2,
      selectedElementId: "parent::child",
      elements: [captured],
    };

    expect(resolveTimelineContextElement({ ...input, sessionEpoch: 3 })).toBeNull();
    expect(resolveTimelineContextElement({ ...input, selectedElementId: "other" })).toBeNull();
    expect(resolveTimelineContextElement({ ...input, elements: [] })).toBeNull();
  });
});

function renderKeyframeOverlay(options: {
  capturedElement: TimelineElement;
  currentElement: TimelineElement;
  setKfContextMenu?: ReturnType<typeof vi.fn>;
  onDeleteAllKeyframes?: ReturnType<typeof vi.fn>;
  onMoveKeyframeToPlayhead?: ReturnType<typeof vi.fn>;
  onSetKeyframeInterpolation?: ReturnType<typeof vi.fn>;
  menu?: Partial<KeyframeDiamondContextMenuState>;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const elements = [options.currentElement];
  const setKfContextMenu = options.setKfContextMenu ?? vi.fn();
  const onDeleteAllKeyframes = options.onDeleteAllKeyframes ?? vi.fn();
  const onSetKeyframeInterpolation = options.onSetKeyframeInterpolation ?? vi.fn();
  const onMoveKeyframeToPlayhead = options.onMoveKeyframeToPlayhead ?? vi.fn();
  const menu: KeyframeDiamondContextMenuState = {
    x: 10,
    y: 10,
    sessionEpoch: 2,
    element: options.capturedElement,
    elementId: options.capturedElement.key ?? options.capturedElement.id,
    percentage: 50,
    animationId: "child-position",
    ...options.menu,
  };

  act(() => {
    usePlayerStore.setState({
      selectedElementId: options.capturedElement.key ?? options.capturedElement.id,
      timelineSessionEpoch: 2,
    });
    root.render(
      createElement(TimelineOverlays, {
        elements,
        elementsRef: { current: elements },
        theme: defaultTimelineTheme,
        kfContextMenu: menu,
        setKfContextMenu,
        onDeleteKeyframe: vi.fn(),
        onDeleteAllKeyframes,
        onMoveKeyframeToPlayhead,
        onSetKeyframeInterpolation,
        clipContextMenu: null,
        setClipContextMenu: vi.fn(),
        currentTime: 0,
        onSplitElement: vi.fn(),
        pinZoomBeforeEdit: vi.fn(),
        onDeleteElement: vi.fn(),
        gapContextMenu: null,
        onDismissGapContextMenu: vi.fn(),
        onCloseTrackGap: vi.fn(),
        onCloseAllTrackGaps: vi.fn(),
        onHoverGapAction: vi.fn(),
      }),
    );
  });
  return { container, setKfContextMenu, onDeleteAllKeyframes, onMoveKeyframeToPlayhead };
}

describe("TimelineOverlays context lifecycle", () => {
  it("does not render persistent timeline shortcut guidance", () => {
    const { container } = renderKeyframeOverlay({
      capturedElement: captured,
      currentElement: captured,
    });

    expect(container.textContent).not.toContain("click/drag to add clips to selection");
  });

  it("dismisses a keyframe menu when its selected target becomes stale", () => {
    const setKfContextMenu = vi.fn();
    renderKeyframeOverlay({
      capturedElement: captured,
      currentElement: captured,
      setKfContextMenu,
    });

    act(() => usePlayerStore.setState({ selectedElementId: "other" }));

    expect(setKfContextMenu).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("dispatches a menu action with the current model element", () => {
    const current = { ...captured, start: 4, track: 7 };
    const onDeleteAllKeyframes = vi.fn();
    renderKeyframeOverlay({
      capturedElement: captured,
      currentElement: current,
      onDeleteAllKeyframes,
    });
    const button = Array.from(document.body.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Delete All Keyframes",
    );

    act(() => button?.click());

    expect(onDeleteAllKeyframes).toHaveBeenCalledExactlyOnceWith(current, "child-position");
  });

  it("forwards the native parameter address when deleting every keyframe", () => {
    const onDeleteAllKeyframes = vi.fn();
    const native = {
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:child",
      parameterId: "transform.rotation",
      keyframeId: "rotation:60",
      frame: 60,
    };
    renderKeyframeOverlay({
      capturedElement: captured,
      currentElement: captured,
      onDeleteAllKeyframes,
      menu: { native },
    });

    const button = Array.from(document.body.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Delete All Keyframes",
    );
    act(() => button?.click());

    expect(onDeleteAllKeyframes).toHaveBeenCalledExactlyOnceWith(
      captured,
      "child-position",
      native,
    );
  });

  it("forwards every grouped native address for delete-all and interpolation", () => {
    const onDeleteAllKeyframes = vi.fn();
    const onSetKeyframeInterpolation = vi.fn();
    const nativeTargets = [
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:child",
        parameterId: "transform.position.x",
        keyframeId: "x:0",
        frame: 0,
        hasFollowingKeyframe: true,
      },
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:child",
        parameterId: "transform.position.y",
        keyframeId: "y:0",
        frame: 0,
        hasFollowingKeyframe: true,
      },
    ] as const;
    renderKeyframeOverlay({
      capturedElement: captured,
      currentElement: captured,
      onDeleteAllKeyframes,
      onSetKeyframeInterpolation,
      menu: { native: nativeTargets[0], nativeTargets },
    });

    const hold = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Hold",
    );
    act(() => hold?.click());

    expect(onSetKeyframeInterpolation).toHaveBeenCalledExactlyOnceWith(
      "parent::child",
      expect.objectContaining({ native: nativeTargets[0], nativeTargets }),
      { type: "hold" },
    );

    const deleteAll = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete All Keyframes",
    );
    act(() => deleteAll?.click());
    expect(onDeleteAllKeyframes).toHaveBeenCalledExactlyOnceWith(
      captured,
      "child-position",
      nativeTargets,
    );
  });

  it("routes a native interpolation preset with the exact current element and native address", () => {
    const onSetKeyframeInterpolation = vi.fn();
    const native = {
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:child",
      parameterId: "transform.rotation",
      keyframeId: "rotation:0",
      frame: 0,
      hasFollowingKeyframe: true,
    };
    renderKeyframeOverlay({
      capturedElement: captured,
      currentElement: captured,
      onSetKeyframeInterpolation,
      menu: { native },
    });

    const easeInOut = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Ease In-Out",
    );
    act(() => easeInOut?.click());

    expect(onSetKeyframeInterpolation).toHaveBeenCalledExactlyOnceWith(
      "parent::child",
      { percentage: 50, native },
      {
        type: "cubic-bezier",
        controlPoints: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
      },
    );
  });

  it("routes native move-to-playhead with the exact current element and keyframe address", () => {
    const current = { ...captured, start: 4, track: 7 };
    const onMoveKeyframeToPlayhead = vi.fn();
    const native = {
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:child",
      parameterId: "transform.rotation",
      keyframeId: "rotation:60",
      frame: 60,
    };
    renderKeyframeOverlay({
      capturedElement: captured,
      currentElement: current,
      onMoveKeyframeToPlayhead,
      menu: { native },
    });

    const move = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Move to Playhead",
    );
    act(() => move?.click());

    expect(onMoveKeyframeToPlayhead).toHaveBeenCalledExactlyOnceWith(current, {
      percentage: 50,
      tweenPercentage: undefined,
      propertyGroup: undefined,
      animationId: "child-position",
      native,
    });
  });

  it("copies the exact rendered animation+tween keyframe on a dense lane", async () => {
    usePlayerStore.setState({
      keyframeCache: new Map([
        [
          captured.key!,
          {
            format: "percentage",
            keyframes: [
              {
                percentage: 50,
                tweenPercentage: 50,
                animationId: "position-tween",
                properties: { x: 100 },
              },
              {
                // This is within the old 0.5%-percentage tolerance, but is a
                // distinct rendered diamond and must not win first-match lookup.
                percentage: 50.18,
                tweenPercentage: 50.18,
                animationId: "position-tween",
                properties: { x: 101 },
              },
            ],
          },
        ],
      ]),
    });
    renderKeyframeOverlay({
      capturedElement: captured,
      currentElement: captured,
      menu: {
        percentage: 50.18,
        tweenPercentage: 50.18,
        animationId: "position-tween",
      },
    });
    const copy = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Copy Properties",
    );

    await act(async () => copy?.click());

    expect(copyTextToClipboard).toHaveBeenCalledExactlyOnceWith('{\n  "x": 101\n}');
  });

  it("copies a clicked native keyframe's own property value instead of a legacy cache row", async () => {
    usePlayerStore.setState({
      keyframeCache: new Map([
        [
          captured.key!,
          {
            format: "percentage",
            keyframes: [{ percentage: 50, properties: { rotation: 999 } }],
          },
        ],
      ]),
    });
    renderKeyframeOverlay({
      capturedElement: captured,
      currentElement: captured,
      menu: {
        native: {
          sequenceId: "sequence:main",
          trackId: "track:v1",
          clipId: "clip:child",
          parameterId: "transform.rotation",
          keyframeId: "rotation:60",
          frame: 60,
          clipDurationFrames: 120,
          properties: { rotation: -180 },
          outgoing: { type: "hold" },
        },
      },
    });
    const copy = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Copy Properties",
    );

    await act(async () => copy?.click());

    expect(copyTextToClipboard).toHaveBeenCalledExactlyOnceWith('{\n  "rotation": -180\n}');
  });

  it("uses the canonical output frame only for legacy menu targets", async () => {
    usePlayerStore.setState({
      keyframeCache: new Map([
        [
          captured.key!,
          {
            format: "percentage",
            keyframes: [{ percentage: 50.01, properties: { opacity: 0.5 } }],
          },
        ],
      ]),
    });
    renderKeyframeOverlay({
      capturedElement: captured,
      currentElement: captured,
      menu: { animationId: undefined, tweenPercentage: undefined },
    });
    const copy = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Copy Properties",
    );

    await act(async () => copy?.click());

    expect(copyTextToClipboard).toHaveBeenCalledExactlyOnceWith('{\n  "opacity": 0.5\n}');
  });

  it("persists Mute for the current double-clicked timeline clip", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const capturedVideo = { ...captured, tag: "video", src: "assets/clip.mp4" };
    const currentVideo = { ...capturedVideo, start: 4 };
    const elements = [currentVideo];
    const onSetElementAttributeQuiet = vi.fn();

    act(() => {
      usePlayerStore.setState({ selectedElementId: capturedVideo.key!, timelineSessionEpoch: 2 });
      root.render(
        createElement(TimelineOverlays, {
          elements,
          elementsRef: { current: elements },
          theme: defaultTimelineTheme,
          kfContextMenu: null,
          setKfContextMenu: vi.fn(),
          onDeleteKeyframe: vi.fn(),
          onDeleteAllKeyframes: vi.fn(),
          onMoveKeyframeToPlayhead: vi.fn(),
          clipContextMenu: { x: 10, y: 10, element: capturedVideo, sessionEpoch: 2 },
          setClipContextMenu: vi.fn(),
          currentTime: 0,
          onSplitElement: vi.fn(),
          onSetElementAttributeQuiet,
          pinZoomBeforeEdit: vi.fn(),
          onDeleteElement: vi.fn(),
          gapContextMenu: null,
          onDismissGapContextMenu: vi.fn(),
          onCloseTrackGap: vi.fn(),
          onCloseAllTrackGaps: vi.fn(),
          onHoverGapAction: vi.fn(),
        }),
      );
    });
    const mute = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Mute"),
    );

    act(() => mute?.click());

    expect(onSetElementAttributeQuiet).toHaveBeenCalledExactlyOnceWith(
      currentVideo,
      "muted",
      "true",
      "Mute clip",
    );
  });
});
