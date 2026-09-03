// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountReactHarness } from "../../hooks/domSelectionTestHarness";
import type { TimelineElement } from "../store/playerStore";
import { usePlayerStore } from "../store/playerStore";
import * as telemetry from "../../telemetry/events";
import type { TimelineKeyframeTarget } from "./timelineKeyframeIdentity";
import {
  beginTimelineKeyframeRetime,
  useTimelineKeyframeHandlers,
} from "./useTimelineKeyframeHandlers";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ELEMENT: TimelineElement = {
  id: "clip-1",
  label: "Hero card",
  tag: "div",
  start: 1,
  duration: 2,
  track: 0,
};

const TARGET: TimelineKeyframeTarget = {
  percentage: 50,
  tweenPercentage: 50,
  propertyGroup: "position",
  animationId: "position-tween",
};

const FLAT_TWEEN_TARGET: TimelineKeyframeTarget = {
  percentage: 100,
  tweenPercentage: 100,
  propertyGroup: "position",
  animationId: "position-tween",
};

const COLLIDING_TARGET: TimelineKeyframeTarget = {
  ...FLAT_TWEEN_TARGET,
  collidingAnimationTargets: [
    { animationId: "position-tween", tweenPercentage: 100 },
    { animationId: "scale-tween", tweenPercentage: 75 },
  ],
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  usePlayerStore.setState({
    focusedEaseSegment: null,
    timelineSessionEpoch: 0,
    selectedKeyframes: new Set(),
    activeKeyframeTarget: null,
    activeKeyframePct: null,
    elements: [],
  });
});

/**
 * Mount the hook on its own and hand back the handlers it returned, with the
 * options every test shares already filled in. Each test overrides only the
 * inputs its assertion is about.
 */
function mountHandlers(options: Partial<Parameters<typeof useTimelineKeyframeHandlers>[0]> = {}) {
  const handlers: Partial<ReturnType<typeof useTimelineKeyframeHandlers>> = {};

  function Harness() {
    Object.assign(
      handlers,
      useTimelineKeyframeHandlers({
        expandedElements: [ELEMENT],
        keyframeCache: new Map(),
        setSelectedElementId: vi.fn(),
        setKfContextMenu: vi.fn(),
        toggleSelectedKeyframe: vi.fn(),
        ...options,
      }),
    );
    return null;
  }

  return { root: mountReactHarness(<Harness />), handlers };
}

describe("useTimelineKeyframeHandlers", () => {
  it("supplies clip timing so a long-clip multi-frame drag is committed", () => {
    const longElement = { ...ELEMENT, start: 0, duration: 120 };
    usePlayerStore.setState({ elements: [longElement], timelineSessionEpoch: 0 });
    const source = document.createElement("button");
    document.body.append(source);
    const onMove = vi.fn().mockResolvedValue(true);
    const onSelect = vi.fn();
    const handle = beginTimelineKeyframeRetime({
      event: {
        currentTarget: source,
        clientX: 6_000,
        clientY: 0,
        pointerId: 17,
        shiftKey: false,
      } as unknown as React.PointerEvent<HTMLElement>,
      elementId: longElement.id,
      keyframeKey: "clip-1:position:50",
      target: TARGET,
      keyframes: [
        { ...TARGET, percentage: 0, tweenPercentage: 0 },
        TARGET,
        { ...TARGET, percentage: 100, tweenPercentage: 100 },
      ],
      clipWidthPx: 12_000,
      draggedIndex: 1,
      sortedClipPercentages: [0, 50, 100],
      onMove,
      onSelect,
      suppressNextClick: vi.fn(),
      keyframeKeyOf: (keyframe) => String(keyframe.percentage),
    });

    act(() => {
      handle.commit({
        currentTarget: source,
        clientX: 6_005,
        clientY: 0,
        pointerId: 17,
        shiftKey: false,
      } as unknown as React.PointerEvent<HTMLElement>);
    });

    expect(onMove).toHaveBeenCalledExactlyOnceWith(TARGET, expect.closeTo(50.041667, 5));
  });

  it("tracks opening the segment ease editor when a timeline segment is selected", () => {
    const trackStudioSegmentEaseEdit = vi
      .spyOn(telemetry, "trackStudioSegmentEaseEdit")
      .mockImplementation(() => {});
    const { root, handlers } = mountHandlers();
    act(() => handlers.onSelectSegment?.(ELEMENT.id, TARGET));

    expect(trackStudioSegmentEaseEdit).toHaveBeenCalledOnce();
    expect(trackStudioSegmentEaseEdit).toHaveBeenCalledWith({ action: "open" });
    act(() => root.unmount());
  });

  it("Shift-deselects the exact active keyframe and clears its full active identity", () => {
    const key = JSON.stringify([
      ELEMENT.id,
      TARGET.propertyGroup,
      TARGET.animationId,
      TARGET.percentage,
      TARGET.tweenPercentage,
    ]);
    const store = usePlayerStore.getState();
    usePlayerStore.setState({ selectedKeyframes: new Set([key]) });
    store.setActiveKeyframeTarget({
      elementId: ELEMENT.id,
      animationId: TARGET.animationId,
      propertyGroup: TARGET.propertyGroup,
      tweenPercentage: TARGET.tweenPercentage ?? TARGET.percentage,
    });
    const { root, handlers } = mountHandlers({
      toggleSelectedKeyframe: store.toggleSelectedKeyframe,
    });

    act(() => handlers.onShiftClickKeyframe?.(ELEMENT.id, TARGET));

    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set());
    expect(usePlayerStore.getState().activeKeyframeTarget).toBeNull();
    expect(usePlayerStore.getState().activeKeyframePct).toBeNull();
    act(() => root.unmount());
  });

  it("does not clear the active identity when Shift-selecting a different keyframe", () => {
    const activeKey = JSON.stringify([
      ELEMENT.id,
      TARGET.propertyGroup,
      TARGET.animationId,
      TARGET.percentage,
      TARGET.tweenPercentage,
    ]);
    const different = { ...TARGET, percentage: 75, tweenPercentage: 75 };
    const activeTarget = {
      elementId: ELEMENT.id,
      animationId: TARGET.animationId,
      propertyGroup: TARGET.propertyGroup,
      tweenPercentage: TARGET.tweenPercentage ?? TARGET.percentage,
    };
    const store = usePlayerStore.getState();
    usePlayerStore.setState({ selectedKeyframes: new Set([activeKey]) });
    store.setActiveKeyframeTarget(activeTarget);
    const { root, handlers } = mountHandlers({
      toggleSelectedKeyframe: store.toggleSelectedKeyframe,
    });

    act(() => handlers.onShiftClickKeyframe?.(ELEMENT.id, different));

    expect(usePlayerStore.getState().selectedKeyframes).toHaveLength(2);
    expect(usePlayerStore.getState().activeKeyframeTarget).toEqual(activeTarget);
    expect(usePlayerStore.getState().activeKeyframePct).toBe(50);
    act(() => root.unmount());
  });

  it("does not clear the active identity when Shift-deselecting a different selected key", () => {
    const activeKey = JSON.stringify([
      ELEMENT.id,
      TARGET.propertyGroup,
      TARGET.animationId,
      TARGET.percentage,
      TARGET.tweenPercentage,
    ]);
    const different = { ...TARGET, percentage: 75, tweenPercentage: 75 };
    const differentKey = JSON.stringify([
      ELEMENT.id,
      different.propertyGroup,
      different.animationId,
      different.percentage,
      different.tweenPercentage,
    ]);
    const activeTarget = {
      elementId: ELEMENT.id,
      animationId: TARGET.animationId,
      propertyGroup: TARGET.propertyGroup,
      tweenPercentage: TARGET.tweenPercentage ?? TARGET.percentage,
    };
    const store = usePlayerStore.getState();
    usePlayerStore.setState({ selectedKeyframes: new Set([activeKey, differentKey]) });
    store.setActiveKeyframeTarget(activeTarget);
    const { root, handlers } = mountHandlers({
      toggleSelectedKeyframe: store.toggleSelectedKeyframe,
    });

    act(() => handlers.onShiftClickKeyframe?.(ELEMENT.id, different));

    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set([activeKey]));
    expect(usePlayerStore.getState().activeKeyframeTarget).toEqual(activeTarget);
    expect(usePlayerStore.getState().activeKeyframePct).toBe(50);
    act(() => root.unmount());
  });

  it("replaces an unsupported cross-element Shift-selection with the clicked key", () => {
    const firstElement = { ...ELEMENT, id: "scenes/a.html#clip" };
    const secondElement = { ...ELEMENT, id: "scenes/b.html#clip" };
    const firstKey = JSON.stringify([
      firstElement.id,
      TARGET.propertyGroup,
      TARGET.animationId,
      TARGET.percentage,
      TARGET.tweenPercentage,
    ]);
    const secondTarget = {
      ...TARGET,
      propertyGroup: "visual",
      animationId: "opacity-tween",
      percentage: 75,
      tweenPercentage: 75,
    };
    const secondKey = JSON.stringify([
      secondElement.id,
      secondTarget.propertyGroup,
      secondTarget.animationId,
      secondTarget.percentage,
      secondTarget.tweenPercentage,
    ]);
    const store = usePlayerStore.getState();
    usePlayerStore.setState({ selectedKeyframes: new Set([firstKey]) });
    store.setActiveKeyframeTarget({
      elementId: firstElement.id,
      animationId: TARGET.animationId,
      propertyGroup: TARGET.propertyGroup,
      tweenPercentage: TARGET.tweenPercentage ?? TARGET.percentage,
    });
    const { root, handlers } = mountHandlers({
      expandedElements: [firstElement, secondElement],
      toggleSelectedKeyframe: store.toggleSelectedKeyframe,
      setSelectedElementId: store.setSelectedElementId,
    });

    act(() => handlers.onShiftClickKeyframe?.(secondElement.id, secondTarget));

    expect(usePlayerStore.getState().selectedKeyframes).toEqual(new Set([secondKey]));
    expect(usePlayerStore.getState().activeKeyframeTarget).toEqual({
      elementId: secondElement.id,
      animationId: secondTarget.animationId,
      propertyGroup: secondTarget.propertyGroup,
      tweenPercentage: secondTarget.tweenPercentage,
    });
    expect(usePlayerStore.getState().activeKeyframePct).toBe(75);
    expect(usePlayerStore.getState().selectedElementId).toBe(secondElement.id);
    act(() => root.unmount());
  });

  it("focuses a merged segment with its colliding animation targets", () => {
    const { root, handlers } = mountHandlers();
    act(() => handlers.onSelectSegment?.(ELEMENT.id, COLLIDING_TARGET));

    expect(usePlayerStore.getState().focusedEaseSegment).toMatchObject({
      animationId: "position-tween",
      collidingAnimationTargets: [
        { animationId: "position-tween", tweenPercentage: 100 },
        { animationId: "scale-tween", tweenPercentage: 75 },
      ],
      tweenPercentage: 100,
      elementId: ELEMENT.id,
    });
    act(() => root.unmount());
  });

  it("focuses a native outgoing segment with its complete source targets and no GSAP identity", () => {
    const { root, handlers } = mountHandlers();
    const nativeTargets = [
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip-1",
        parameterId: "transform.position.x",
        keyframeId: "key:x:0",
        frame: 0,
        hasFollowingKeyframe: true,
        outgoing: { type: "linear" as const },
      },
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip-1",
        parameterId: "transform.position.y",
        keyframeId: "key:y:0",
        frame: 0,
        hasFollowingKeyframe: true,
        outgoing: { type: "linear" as const },
      },
    ];

    act(() =>
      handlers.onSelectSegment?.(ELEMENT.id, {
        percentage: 0,
        tweenPercentage: 0,
        propertyGroup: "position",
        native: nativeTargets[0],
        nativeTargets,
      }),
    );

    expect(usePlayerStore.getState().focusedEaseSegment).toMatchObject({
      kind: "native",
      elementId: ELEMENT.id,
      tweenPercentage: 0,
      nativeTargets,
    });
    expect(usePlayerStore.getState().focusedEaseSegment?.animationId).toBeUndefined();
    act(() => root.unmount());
  });

  it("keeps every grouped native scalar in the diamond context-menu state", () => {
    const setKfContextMenu = vi.fn();
    const { root, handlers } = mountHandlers({ setKfContextMenu });
    const nativeTargets = [
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip-1",
        parameterId: "transform.position.x",
        keyframeId: "key:x:30",
        frame: 30,
        hasFollowingKeyframe: true,
      },
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip-1",
        parameterId: "transform.position.y",
        keyframeId: "key:y:30",
        frame: 30,
        hasFollowingKeyframe: true,
      },
    ];

    act(() =>
      handlers.onContextMenuKeyframe?.(
        { clientX: 12, clientY: 24, preventDefault: vi.fn() } as never,
        ELEMENT.id,
        {
          percentage: 50,
          propertyGroup: "position",
          native: nativeTargets[0],
          nativeTargets,
        },
      ),
    );

    expect(setKfContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ native: nativeTargets[0], nativeTargets }),
    );
    act(() => root.unmount());
  });

  it("focuses a flat tween segment without seeking, while keyframe clicks still seek", () => {
    const onSeek = vi.fn();
    const onSelectElement = vi.fn();
    const setSelectedElementId = vi.fn();
    const { root, handlers } = mountHandlers({ onSelectElement, onSeek, setSelectedElementId });

    // Selecting a segment must NOT move the playhead.
    act(() => handlers.onSelectSegment?.(ELEMENT.id, FLAT_TWEEN_TARGET));
    expect(onSeek).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().focusedEaseSegment).toMatchObject({
      animationId: "position-tween",
      tweenPercentage: 100,
      elementId: ELEMENT.id,
    });
    expect(usePlayerStore.getState().focusedEaseSegment?.collidingAnimationTargets).toBeUndefined();
    expect(setSelectedElementId).toHaveBeenCalledWith(ELEMENT.id);
    expect(onSelectElement).toHaveBeenCalledWith(ELEMENT);

    // Clicking the keyframe itself still seeks to it (start 1 + 50% of 2 = 2).
    act(() => handlers.onClickKeyframe?.(ELEMENT, TARGET));
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(2);
    act(() => root.unmount());
  });

  it("keeps the clicked animation identity with the active keyframe percentage", () => {
    const { root, handlers } = mountHandlers();

    act(() => handlers.onClickKeyframe?.(ELEMENT, COLLIDING_TARGET));

    expect(
      (usePlayerStore.getState() as unknown as { activeKeyframeTarget?: unknown })
        .activeKeyframeTarget,
    ).toEqual({
      elementId: ELEMENT.id,
      animationId: "position-tween",
      propertyGroup: "position",
      tweenPercentage: 100,
      collidingAnimationTargets: [
        { animationId: "position-tween", tweenPercentage: 100 },
        { animationId: "scale-tween", tweenPercentage: 75 },
      ],
    });
    act(() => root.unmount());
  });

  it("scopes a keyframe context target to the opening timeline session", () => {
    const setKfContextMenu = vi.fn();
    usePlayerStore.setState({ timelineSessionEpoch: 4 });

    function Harness() {
      const { onContextMenuKeyframe } = useTimelineKeyframeHandlers({
        expandedElements: [ELEMENT],
        keyframeCache: new Map(),
        setSelectedElementId: vi.fn(),
        setKfContextMenu,
        toggleSelectedKeyframe: vi.fn(),
      });
      return (
        <button
          type="button"
          onContextMenu={(event) => onContextMenuKeyframe(event, ELEMENT.id, TARGET)}
        />
      );
    }

    const root = mountReactHarness(<Harness />);
    const button = document.querySelector("button");
    expect(button).not.toBeNull();
    act(() => {
      button?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 }),
      );
    });

    expect(setKfContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ elementId: ELEMENT.id, sessionEpoch: 4, x: 14, y: 22 }),
    );
    act(() => root.unmount());
  });

  it("uses the rendered animation+tween identity for a dense lane context menu", () => {
    const setKfContextMenu = vi.fn();
    const denseTarget: TimelineKeyframeTarget = {
      percentage: 50.18,
      tweenPercentage: 50.18,
      propertyGroup: "position",
      animationId: "position-tween",
    };
    const { root, handlers } = mountHandlers({
      setKfContextMenu,
      keyframeCache: new Map([
        [
          ELEMENT.id,
          {
            format: "percentage",
            keyframes: [
              // This is close enough for the old 0.2%-based lookup but is a
              // different rendered diamond.
              {
                percentage: 50,
                tweenPercentage: 50,
                animationId: "position-tween",
                propertyGroup: "position",
                properties: { x: 100 },
                ease: "power1.in",
              },
              {
                percentage: 50.18,
                tweenPercentage: 50.18,
                animationId: "position-tween",
                propertyGroup: "position",
                properties: { x: 101 },
                ease: "power4.out",
              },
            ],
          },
        ],
      ]),
    });
    const event = { clientX: 10, clientY: 20 } as React.MouseEvent;

    act(() => handlers.onContextMenuKeyframe?.(event, ELEMENT.id, denseTarget));

    expect(setKfContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ tweenPercentage: 50.18, currentEase: "power4.out" }),
    );
    act(() => root.unmount());
  });
});
