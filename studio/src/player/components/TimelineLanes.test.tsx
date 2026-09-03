// @vitest-environment happy-dom

import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineLanes } from "./TimelineLanes";
import { getTrackStyle } from "./timelineIcons";
import { defaultTimelineTheme } from "./timelineTheme";
import { EFFECT_STRIP_H, GUTTER, LABEL_COL_W, TRACK_H, getTimelineRowGeometry } from "./timelineLayout";
import { createTimelineClipIndex } from "../lib/timelineClipIndex";
import { buildTimelineLogicalRows } from "./timelineKeyboardNavigation";
import { usePlayerStore, type KeyframeCacheEntry, type TimelineElement } from "../store/playerStore";
import type { MultiDragPreviewInput } from "./timelineMultiDragPreview";
import type { TimelineEditCallbacks } from "./timelineCallbacks";
import type { DraggedClipState, BlockedClipState } from "./useTimelineClipDrag";
import type { NativeTimelineElementLaneProjection } from "./nativeTimelinePropertyLaneBridge";
import type { TimelineKeyframeTarget } from "./timelineKeyframeIdentity";
import type { NativeClipEffect } from "../../project/nativeProjectDocument";
import { timelineTrackOriginGapColor } from "./timelineTrackOriginGapColor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  usePlayerStore.getState().reset();
});

/** The z-order sort keys really are fractional: a clip nudged between two lanes
 *  lands on the midpoint. These are the values that used to reach aria-label. */
const TRACK_A = 1 / 6;
const TRACK_B = 0.5;

/** Every string a screen reader or a sighted user actually reads. */
function visibleText(host: HTMLElement): string {
  return host.textContent ?? "";
}

function ariaLabels(host: HTMLElement): string {
  return Array.from(host.querySelectorAll("[aria-label]"))
    .map((el) => el.getAttribute("aria-label") ?? "")
    .join(" ");
}

function element(id: string, track: number): TimelineElement {
  return { id, label: id, tag: "div", start: 0, duration: 2, track };
}

function positionTween(id: string): GsapAnimation {
  return {
    id: `${id}-tween`,
    targetSelector: `#${id}`,
    method: "to",
    position: 0,
    duration: 2,
    properties: {},
    propertyGroup: "position",
    keyframes: {
      format: "percentage",
      keyframes: [
        { percentage: 0, properties: { x: 0 } },
        { percentage: 100, properties: { x: 100 } },
      ],
    },
  };
}

interface RenderLanesOptions {
  elements?: TimelineElement[];
  animations?: Map<string, GsapAnimation[]>;
  expandedClipIds?: string[];
  selectedElementIds?: Set<string>;
  multiDragPreview?: MultiDragPreviewInput | null;
  draggedClip?: DraggedClipState | null;
  onToggleTrackHidden?: TimelineEditCallbacks["onToggleTrackHidden"];
  onContextMenuLane?: (e: React.MouseEvent, track: number, time: number) => void;
  onContextMenuClip?: (e: React.MouseEvent, element: TimelineElement) => void;
  onDrillDown?: (element: TimelineElement) => void;
  nativeLaneProjections?: ReadonlyMap<string, NativeTimelineElementLaneProjection>;
  nativeEffectMap?: ReadonlyMap<string, readonly NativeClipEffect[]>;
  keyframeCache?: Map<string, KeyframeCacheEntry>;
  onClickKeyframe?: (element: TimelineElement, target: TimelineKeyframeTarget) => void;
}

function renderLanes(options: RenderLanesOptions = {}): {
  host: HTMLDivElement;
  root: Root;
  rerender: (next: RenderLanesOptions) => void;
  setSelectedElementId: ReturnType<typeof vi.fn>;
  onSelectElement: ReturnType<typeof vi.fn>;
} {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const setSelectedElementId = vi.fn();
  const onSelectElement = vi.fn();
  const render = (next: RenderLanesOptions) => {
    const elements = next.elements ?? [element("clip-a", TRACK_A)];
    const gsapAnimations = next.animations ?? new Map<string, GsapAnimation[]>();
    const displayTrackOrder = [...new Set(elements.map((el) => el.track))].sort((a, b) => a - b);
    const tracks: [number, TimelineElement[]][] = displayTrackOrder.map((track) => [
      track,
      elements.filter((el) => el.track === track),
    ]);
    const laneCounts = new Map(
      elements.map((el) => {
        const key = el.key ?? el.id;
        const native = next.nativeLaneProjections?.get(key);
        return [
          key,
          native
            ? new Set(native.lanes.map((lane) => lane.propertyGroup)).size
            : (gsapAnimations.get(key) ?? []).length,
        ];
      }),
    );
    const rowHeights = displayTrackOrder.map(() => TRACK_H);
    act(() => {
      usePlayerStore.setState({ expandedClipIds: new Set(next.expandedClipIds ?? []) });
      root.render(
        <TimelineLanes
          pps={100}
          contentOrigin={LABEL_COL_W + GUTTER}
          contentGutter={GUTTER}
          trackContentWidth={800}
          theme={defaultTimelineTheme}
          displayTrackOrder={displayTrackOrder}
          rowHeights={rowHeights}
          rowGeometry={getTimelineRowGeometry(rowHeights)}
          virtualRows={displayTrackOrder.map((_, index) => ({ index, rowKey: index }))}
          rowsVirtualized={false}
          focusedTargetId={null}
          logicalRows={buildTimelineLogicalRows({
            tracks,
            displayTrackOrder,
            laneCounts,
            selectedElementId: null,
            selectedElementIds: next.selectedElementIds ?? new Set(),
            expandedClipIds: new Set(next.expandedClipIds ?? []),
            collapsedGroupIds: new Set(),
            expandedLaneOwnerIds: new Set(),
            groups: [],
            trackGroupOf: new Map(),
            gsapAnimations,
            nativeLaneProjections: next.nativeLaneProjections,
          })}
          clipIndex={createTimelineClipIndex(tracks)}
          renderTimeRange={{ start: 0, end: Number.POSITIVE_INFINITY }}
          visibleTimeRange={{ start: 0, end: Number.POSITIVE_INFINITY }}
          pinnedClipIdentities={new Set()}
          trackOrder={displayTrackOrder}
          tracks={tracks}
          trackStyles={new Map()}
          groups={[]}
          laneCounts={laneCounts}
          nativeLaneProjections={next.nativeLaneProjections ?? new Map()}
          nativeEffectMap={next.nativeEffectMap ?? new Map()}
          keyframeCache={next.keyframeCache}
          selectedElementId={null}
          selectedElementIds={next.selectedElementIds ?? new Set()}
          hoveredClip={null}
          draggedClip={next.draggedClip ?? null}
          draggedElement={null}
          multiDragPreview={next.multiDragPreview ?? null}
          blockedClipRef={createRef<BlockedClipState | null>()}
          suppressClickRef={{ current: false }}
          scrollRef={createRef<HTMLDivElement>()}
          setHoveredClip={vi.fn()}
          setResizingClip={vi.fn()}
          setDraggedClip={vi.fn()}
          setSelectedElementId={setSelectedElementId}
          getPreviewElement={(el) => el}
          getTrackStyle={getTrackStyle}
          gsapAnimations={gsapAnimations}
          selectedKeyframes={new Set()}
          currentTime={0}
          onClickKeyframe={next.onClickKeyframe}
          onContextMenuLane={next.onContextMenuLane}
          onContextMenuClip={next.onContextMenuClip}
          onDrillDown={next.onDrillDown}
          onToggleTrackHidden={next.onToggleTrackHidden}
          onTogglePropertyGroupKeyframe={vi.fn()}
          onResizeElement={vi.fn()}
          onMoveElement={vi.fn()}
          onSelectElement={onSelectElement}
          onRazorSplit={vi.fn()}
          onRazorSplitAll={vi.fn()}
        />,
      );
    });
  };
  render(options);
  return { host, root, rerender: render, setSelectedElementId, onSelectElement };
}

function visibilityLabels(host: HTMLElement): (string | null)[] {
  return Array.from(host.querySelectorAll("button[aria-label^='Hide track ']")).map((button) =>
    button.getAttribute("aria-label"),
  );
}

function nativeCoincidentPositionProjection(): NativeTimelineElementLaneProjection {
  const native = (parameterId: string, keyframeId: string, frame: number) => ({
    sequenceId: "sequence:main",
    trackId: "track:v1",
    clipId: "clip:native",
    parameterId,
    keyframeId,
    frame,
  });
  // Deliberately y-before-x: compact and expanded rendering must be stable by
  // native identity, not accidental incoming array order.
  return {
    sequenceId: "sequence:main",
    trackId: "track:v1",
    clipId: "clip:native",
    lanes: [
      {
        id: "native:y",
        propertyGroup: "position",
        keyframes: [
          {
            id: "y:0",
            percentage: 0,
            properties: { y: 0 },
            native: native("transform.position.y", "y:0", 0),
          },
          {
            id: "y:30",
            percentage: 50,
            properties: { y: 80 },
            native: native("transform.position.y", "y:30", 30),
          },
        ],
      },
      {
        id: "native:x",
        propertyGroup: "position",
        keyframes: [
          {
            id: "x:0",
            percentage: 0,
            properties: { x: 0 },
            native: native("transform.position.x", "x:0", 0),
          },
          {
            id: "x:30",
            percentage: 50,
            properties: { x: 120 },
            native: native("transform.position.x", "x:30", 30),
          },
        ],
      },
    ],
  };
}

describe("TimelineLanes track numbering", () => {
  // Screen readers literally announced "Hide track 0.16666666666666666".
  it("numbers tracks contiguously from 1 regardless of the fractional sort keys", () => {
    const view = renderLanes({
      elements: [element("clip-a", TRACK_A), element("clip-b", TRACK_B)],
    });

    expect(visibilityLabels(view.host)).toEqual(["Hide track 1", "Hide track 2"]);
    expect(view.host.querySelectorAll("[data-timeline-row]")).toHaveLength(2);
    // Only what a user reads. The fractional key still identifies the row in
    // `id` / `data-` attributes, which is exactly where an opaque sort key
    // belongs.
    expect(visibleText(view.host)).not.toContain("0.16666666666666666");
    expect(ariaLabels(view.host)).not.toContain("0.16666666666666666");
    act(() => view.root.unmount());
  });

  it("hands the visibility toggle the real track key, not the display index", () => {
    const onToggleTrackHidden = vi.fn();
    const view = renderLanes({
      elements: [element("clip-a", TRACK_A), element("clip-b", TRACK_B)],
      onToggleTrackHidden,
    });

    const second = view.host.querySelector<HTMLButtonElement>('button[aria-label="Hide track 2"]');
    act(() => second?.click());

    // Both, and they are different numbers: the real key acts, the display row
    // is what the undo-history label must announce (see `onToggleTrackHidden`).
    expect(onToggleTrackHidden).toHaveBeenCalledWith(TRACK_B, true, 2);
    act(() => view.root.unmount());
  });

  // The gap menu inserts at the track it is given, so a display index here would
  // drop the new clip on the wrong lane.
  it("hands the lane context menu the real track key, not the display index", () => {
    const onContextMenuLane = vi.fn();
    const view = renderLanes({
      elements: [element("clip-a", TRACK_A), element("clip-b", TRACK_B)],
      onContextMenuLane,
    });

    // The lane's own content cell. Query its semantic role so the intentional
    // origin-gap spacer does not turn DOM order into an interaction contract.
    const secondTrackContent = view.host
      .querySelectorAll("[data-timeline-row]")[1]
      ?.querySelector('[role="row"]')
      ?.querySelector('[role="gridcell"]');
    act(() => {
      secondTrackContent?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100 }),
      );
    });

    expect(onContextMenuLane).toHaveBeenCalledOnce();
    expect(onContextMenuLane.mock.calls[0]?.[1]).toBe(TRACK_B);
    act(() => view.root.unmount());
  });
});

describe("TimelineLanes disclosure target", () => {
  const ANIMATIONS = new Map([["clip-a", [positionTween("clip-a")]]]);

  function propertyStrip(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>("[data-timeline-property-lane]");
  }

  it("renders keyframe lanes as editable rows, not colored effect strips", () => {
    const view = renderLanes({ animations: ANIMATIONS, expandedClipIds: ["clip-a"] });
    const target = propertyStrip(view.host);

    expect(target).not.toBeNull();
    expect(target?.dataset.timelineNestedStrip).toBeUndefined();
    expect(target?.style.height).toBe("28px");
    expect(target?.style.backgroundColor).toBe("");
    act(() => view.root.unmount());
  });

  it("renders authoritative native project lanes when no GSAP animation exists", () => {
    const nativeLaneProjections = new Map<string, NativeTimelineElementLaneProjection>([
      [
        "clip-a",
        {
          sequenceId: "sequence:main",
          trackId: "track:v1",
          clipId: "clip:native",
          lanes: [
            {
              id: "native:rotation",
              propertyGroup: "rotation",
              keyframes: [
                {
                  id: "rotation:0",
                  percentage: 0,
                  properties: { rotation: 0 },
                  native: {
                    sequenceId: "sequence:main",
                    trackId: "track:v1",
                    clipId: "clip:native",
                    parameterId: "transform.rotation",
                    keyframeId: "rotation:0",
                    frame: 0,
                  },
                },
                {
                  id: "rotation:30",
                  percentage: 50,
                  properties: { rotation: -180 },
                  native: {
                    sequenceId: "sequence:main",
                    trackId: "track:v1",
                    clipId: "clip:native",
                    parameterId: "transform.rotation",
                    keyframeId: "rotation:30",
                    frame: 30,
                  },
                },
              ],
            },
          ],
        },
      ],
    ]);
    const view = renderLanes({
      nativeLaneProjections,
      expandedClipIds: ["clip-a"],
    });

    expect(view.host.querySelectorAll('[data-property-group="rotation"] button[data-keyframe-percentage]')).toHaveLength(2);
    expect(view.host.querySelector('[data-property-group="position"]')).toBeNull();
    act(() => view.root.unmount());
  });

  it("renders collapsed native diamonds without a GSAP cache, deduping coincident frames by stable native identity", () => {
    const onClickKeyframe = vi.fn();
    const nativeLaneProjections = new Map<string, NativeTimelineElementLaneProjection>([
      ["clip-a", nativeCoincidentPositionProjection()],
    ]);
    const view = renderLanes({ nativeLaneProjections, onClickKeyframe });

    const diamonds = Array.from(
      view.host.querySelectorAll<HTMLButtonElement>("button[data-keyframe-at-playhead][title]"),
    );
    expect(diamonds.map((diamond) => diamond.getAttribute("title"))).toEqual(["0%", "50%"]);

    act(() => {
      diamonds[1]?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    });
    expect(onClickKeyframe).toHaveBeenCalledWith(
      expect.objectContaining({ id: "clip-a" }),
      expect.objectContaining({
        propertyGroup: "position",
        animationId: "native:x",
        native: expect.objectContaining({
          parameterId: "transform.position.x",
          keyframeId: "x:30",
          frame: 30,
        }),
      }),
    );
    act(() => view.root.unmount());
  });

  it("keeps unmatched legacy compact diamonds beside native-owned groups", () => {
    const nativeLaneProjections = new Map<string, NativeTimelineElementLaneProjection>([
      ["clip-a", nativeCoincidentPositionProjection()],
    ]);
    const keyframeCache = new Map<string, KeyframeCacheEntry>([
      [
        "clip-a",
        {
          format: "percentage",
          keyframes: [
            {
              percentage: 0,
              propertyGroup: "visual",
              animationId: "legacy-opacity",
              properties: { opacity: 1 },
            },
            {
              percentage: 100,
              propertyGroup: "position",
              animationId: "legacy-position",
              properties: { x: 100 },
            },
          ],
        },
      ],
    ]);
    const view = renderLanes({ nativeLaneProjections, keyframeCache });

    const labels = Array.from(view.host.querySelectorAll<HTMLButtonElement>("button[aria-label]"))
      .map((button) => button.getAttribute("aria-label"))
      .filter((label): label is string => label != null);
    expect(labels.some((label) => label.startsWith("visual keyframe"))).toBe(true);
    expect(labels.some((label) => label.startsWith("position keyframe"))).toBe(true);
    expect(labels.filter((label) => label.startsWith("position keyframe"))).toHaveLength(2);
    act(() => view.root.unmount());
  });

  it("does not duplicate coincident native frames when the native property lane is expanded", () => {
    const nativeLaneProjections = new Map<string, NativeTimelineElementLaneProjection>([
      ["clip-a", nativeCoincidentPositionProjection()],
    ]);
    const view = renderLanes({ nativeLaneProjections, expandedClipIds: ["clip-a"] });

    expect(
      view.host.querySelectorAll('[data-timeline-property-lane][data-property-group="position"]'),
    ).toHaveLength(1);
    expect(
      view.host.querySelectorAll(
        '[data-timeline-property-lane][data-property-group="position"] button[data-keyframe-percentage]',
      ),
    ).toHaveLength(2);
    act(() => view.root.unmount());
  });

  it("collapses keyframe lanes behind their disclosure toggle", () => {
    const view = renderLanes({ animations: ANIMATIONS, expandedClipIds: [] });
    const strip = view.host.querySelector<HTMLElement>("[data-timeline-property-lane]");

    expect(strip).toBeNull();
    expect(view.host.querySelector("button[aria-label='Expand clip-a lanes']")).not.toBeNull();
    act(() => view.root.unmount());
  });

  it("shows thin, opaque, labelled effect strips immediately below every owning media clip", () => {
    const clips = [
      { ...element("clip-a", TRACK_A), tag: "video", start: 0, duration: 2, colorGrading: '{"preset":"clean-studio"}' },
      { ...element("clip-b", TRACK_A), tag: "video", start: 2, duration: 3, colorGrading: '{"preset":"warm-daylight"}' },
    ];
    const view = renderLanes({
      elements: clips,
      animations: new Map(),
    });
    const strips = [...view.host.querySelectorAll<HTMLElement>("[data-timeline-effect-strips]")];

    expect(strips.map((strip) => strip.getAttribute("data-effect-owner-id"))).toEqual(["clip-a", "clip-b"]);
    expect(strips.every((strip) => strip.closest("[data-el-id]") === null)).toBe(true);
    for (const strip of strips) {
      const color = strip.querySelector<HTMLElement>('[data-timeline-effect-strip="color-grading"]');
      expect(color?.textContent).toBe("Color");
      expect(color?.style.height).toBe(`${EFFECT_STRIP_H}px`);
      expect(color?.style.opacity).toBe("1");
      expect(strip.style.top).toBe(`${TRACK_H}px`);
    }
    act(() => view.root.unmount());
  });

  it("colors the origin gap by imported media type", () => {
    const cases: Array<[TimelineElement, string]> = [
      [{ ...element("video", TRACK_A), tag: "video" }, "#FF5353FF"],
      [{ ...element("photo", TRACK_A), tag: "img" }, "#3B82F6"],
      [{ ...element("audio", TRACK_A), tag: "audio" }, "#A855F7"],
    ];
    for (const [media, expected] of cases) {
      const view = renderLanes({ elements: [media] });
      const gap = view.host.querySelector<HTMLElement>("[data-timeline-origin-gap]");
      expect(timelineTrackOriginGapColor([media], defaultTimelineTheme)).toBe(expected);
      expect(gap?.style.backgroundColor).toBe(expected);
      act(() => view.root.unmount());
    }
  });

  // Two timelines on one page (a mini-timeline in a modal beside the main one)
  // both minted `timeline-lanes-track-0`, so every caret's aria-controls
  // resolved to whichever instance mounted first.
  it("mints lane ids that do not collide with a second TimelineLanes on the page", () => {
    const first = renderLanes({ animations: ANIMATIONS, expandedClipIds: ["clip-a"] });
    const second = renderLanes({ animations: ANIMATIONS, expandedClipIds: ["clip-a"] });

    const idsFor = (host: HTMLElement) =>
      Array.from(host.querySelectorAll<HTMLElement>("[data-timeline-property-lanes][id]"), (lane) =>
        lane.getAttribute("id"),
      ).filter((id): id is string => id !== null);
    const firstIds = idsFor(first.host);
    const secondIds = idsFor(second.host);
    const cellIdsFor = (host: HTMLElement) =>
      new Set(
        Array.from(host.querySelectorAll<HTMLElement>("[data-property-group][id]"), (cell) =>
          cell.getAttribute("id"),
        ).filter((id): id is string => id !== null),
      );
    const ownedIdsFor = (host: HTMLElement) =>
      Array.from(host.querySelectorAll("[aria-owns]"), (owner) =>
        owner.getAttribute("aria-owns"),
      ).filter((id): id is string => id !== null);
    const firstCellIds = cellIdsFor(first.host);
    const secondCellIds = cellIdsFor(second.host);

    for (const { host } of [first, second]) {
      const treegrid = host.querySelector<HTMLElement>('[role="treegrid"]');
      expect(treegrid?.getAttribute("aria-colcount")).toBe("2");
      expect(treegrid?.hasAttribute("aria-multiselectable")).toBe(false);
      expect(
        [...host.querySelectorAll('[role="rowheader"]')].every(
          (cell) => cell.getAttribute("aria-colindex") === "1",
        ),
      ).toBe(true);
      expect(
        [...host.querySelectorAll('[role="gridcell"]')].every(
          (cell) => cell.getAttribute("aria-colindex") === "2",
        ),
      ).toBe(true);
    }
    expect(firstIds.length).toBeGreaterThan(0);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
    expect(firstCellIds.size).toBeGreaterThan(0);
    expect([...firstCellIds].some((id) => secondCellIds.has(id))).toBe(false);
    expect(ownedIdsFor(first.host).every((id) => firstCellIds.has(id))).toBe(true);
    expect(ownedIdsFor(second.host).every((id) => secondCellIds.has(id))).toBe(true);
    // Still a legal CSS id selector: the aria-controls lookups above use `#id`.
    for (const id of [...firstIds, ...secondIds]) {
      expect(id).toMatch(/^[A-Za-z][\w-]*$/);
    }
    act(() => first.root.unmount());
    act(() => second.root.unmount());
  });

  // The passenger branch wraps [clip, lanes] in a transformed div that re-renders
  // on every pointer move. An unstable key there remounts the lanes and drops the
  // in-flight drag.
  it("does not remount the lanes while a multi-clip drag slides the formation", () => {
    const elements = [element("clip-a", TRACK_A), element("clip-b", TRACK_A)];
    const selectedElementIds = new Set(["clip-a", "clip-b"]);
    const preview = (draggedPreviewStart: number): MultiDragPreviewInput => ({
      dragStarted: true,
      draggedKey: "clip-b",
      draggedOriginStart: 0,
      draggedPreviewStart,
      selectedKeys: selectedElementIds,
    });
    const view = renderLanes({
      elements,
      animations: ANIMATIONS,
      expandedClipIds: ["clip-a"],
      selectedElementIds,
      multiDragPreview: preview(0.25),
    });

    const beforeLane = propertyStrip(view.host);
    const passengerClip = view.host.querySelector<HTMLElement>('[data-el-id="clip-a"]');
    expect(beforeLane).not.toBeNull();
    expect(passengerClip?.style.borderTopLeftRadius).toBe("3px");

    view.rerender({
      elements,
      animations: ANIMATIONS,
      expandedClipIds: ["clip-a"],
      selectedElementIds,
      multiDragPreview: preview(0.75),
    });

    // Node identity, not just presence: a remount replaces these nodes.
    expect(propertyStrip(view.host)).toBe(beforeLane);
    expect(passengerClip?.style.borderTopLeftRadius).toBe("3px");

    view.rerender({
      elements,
      animations: ANIMATIONS,
      expandedClipIds: ["clip-a"],
      selectedElementIds,
      multiDragPreview: preview(0),
    });
    expect(passengerClip?.style.borderTopLeftRadius).toBe("0px");
    act(() => view.root.unmount());
  });
});

describe("TimelineLanes selection", () => {
  it("keeps a selected clip selected when it is clicked again", () => {
    const selected = element("clip-a", TRACK_A);
    const view = renderLanes({
      elements: [selected],
      selectedElementIds: new Set([selected.id]),
    });

    act(() => view.host.querySelector<HTMLButtonElement>('[data-el-id="clip-a"]')?.click());

    expect(view.setSelectedElementId).toHaveBeenCalledWith(selected.id);
    expect(view.onSelectElement).toHaveBeenCalledWith(selected);
    act(() => view.root.unmount());
  });

  it("opens clip actions when ordinary media is double-clicked", () => {
    const video: TimelineElement = {
      id: "clip-video",
      label: "Clip video",
      tag: "video",
      src: "assets/clip.mp4",
      start: 0,
      duration: 2,
      track: TRACK_A,
    };
    const onContextMenuClip = vi.fn();
    const view = renderLanes({ elements: [video], onContextMenuClip });
    const clip = view.host.querySelector<HTMLButtonElement>('[data-el-id="clip-video"]');

    act(() =>
      clip?.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, clientX: 120, clientY: 80 }),
      ),
    );

    expect(onContextMenuClip).toHaveBeenCalledOnce();
    expect(onContextMenuClip.mock.calls[0]?.[1]).toBe(video);
    act(() => view.root.unmount());
  });

  it("keeps composition double-click reserved for opening that composition", () => {
    const composition: TimelineElement = {
      id: "nested",
      label: "Nested",
      tag: "div",
      compositionSrc: "compositions/nested.html",
      start: 0,
      duration: 2,
      track: TRACK_A,
    };
    const onContextMenuClip = vi.fn();
    const onDrillDown = vi.fn();
    const view = renderLanes({ elements: [composition], onContextMenuClip, onDrillDown });

    act(() =>
      view.host
        .querySelector<HTMLButtonElement>('[data-el-id="nested"]')
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );

    expect(onDrillDown).toHaveBeenCalledWith(composition);
    expect(onContextMenuClip).not.toHaveBeenCalled();
    act(() => view.root.unmount());
  });
});
