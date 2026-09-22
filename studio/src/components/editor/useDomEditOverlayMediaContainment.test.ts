// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { createDomEditOverlayGestureHandlers } from "./useDomEditOverlayGestures";
import type { DomEditSelection } from "./domEditing";
import type {
  GestureState,
  UseDomEditOverlayGesturesOptions,
} from "./domEditOverlayGestures";
import type { ManualOffsetDragMember } from "./manualOffsetDrag";
import { readStudioBoxSize } from "./manualEdits";

function ref<T>(current: T) {
  return { current };
}

function selection(element: HTMLElement): DomEditSelection {
  return {
    element,
    id: "clip",
    selector: "#clip",
    selectorIndex: 0,
    sourceFile: "index.html",
    tagName: element.tagName.toLowerCase(),
    label: "Clip",
    textContent: "",
    textFields: [],
    capabilities: {},
    computedStyle: { display: "block", position: "absolute" },
  } as unknown as DomEditSelection;
}

function moveHarness(element: HTMLElement) {
  const selected = selection(element);
  const setOverlayRect = vi.fn();
  const gesture: GestureState = {
    kind: "drag",
    mode: "path-offset",
    selection: selected,
    startX: 0,
    startY: 0,
    centerX: 900,
    centerY: 300,
    initialPathOffset: { x: 0, y: 0, translate: "" },
    initialRotation: { angle: 0, rotate: "" },
    initialBoxSize: {
      width: 100,
      height: 100,
      inlineWidth: "",
      inlineHeight: "",
    },
    originLeft: 850,
    originTop: 250,
    originWidth: 100,
    originHeight: 100,
    actualWidth: 100,
    actualHeight: 100,
    actualRotation: 0,
    editScaleX: 1,
    editScaleY: 1,
    contentScaleX: 1,
    contentScaleY: 1,
    snapContext: {
      targets: [],
      compositionTarget: {
        id: "composition",
        left: 0,
        top: 0,
        right: 1000,
        bottom: 600,
        centerX: 500,
        centerY: 300,
      },
      gridEdges: null,
      snapEnabled: false,
    },
  };
  const box = document.createElement("div");
  const opts = {
    overlayRef: ref<HTMLDivElement | null>(null),
    iframeRef: ref<HTMLIFrameElement | null>(null),
    boxRef: ref<HTMLDivElement | null>(box),
    selectionRef: ref<DomEditSelection | null>(selected),
    hoverSelectionRef: ref<DomEditSelection | null>(null),
    overlayRectRef: ref(null),
    groupOverlayItemsRef: ref([]),
    gestureRef: ref<GestureState | null>(gesture),
    groupGestureRef: ref(null),
    blockedMoveRef: ref(null),
    rafPausedRef: ref(false),
    suppressNextBoxClickRef: ref(false),
    setOverlayRect,
    setGroupOverlayItems: vi.fn(),
    onBlockedMoveRef: ref(vi.fn()),
    onManualDragStartRef: ref(vi.fn()),
    onPathOffsetCommitRef: ref(vi.fn()),
    onGroupPathOffsetCommitRef: ref(vi.fn()),
    onBoxSizeCommitRef: ref(vi.fn()),
    onRotationCommitRef: ref(vi.fn()),
    onCanvasPointerMoveRef: ref(vi.fn()),
    onCanvasMouseDown: vi.fn(),
    snapGuidesRef: ref(null),
  } as unknown as UseDomEditOverlayGesturesOptions;

  return {
    box,
    handlers: createDomEditOverlayGestureHandlers(opts),
    gesture,
    setOverlayRect,
  };
}

function pointer(clientX: number, clientY: number) {
  return {
    clientX,
    clientY,
    altKey: true,
    shiftKey: false,
  } as unknown as React.PointerEvent<HTMLDivElement>;
}

function enableDragCommit(gesture: GestureState, element: HTMLElement) {
  gesture.pathOffsetMember = {
    key: "clip",
    selection: gesture.selection,
    element,
    initialOffset: { x: 0, y: 0 },
    baseGsap: { x: 0, y: 0 },
    initialPathOffset: gesture.initialPathOffset,
    gestureToken: "test-drag",
    screenToOffset: { a: 1, b: 0, c: 0, d: 1 },
    originRect: {
      left: gesture.originLeft,
      top: gesture.originTop,
      width: gesture.originWidth,
      height: gesture.originHeight,
    },
  } satisfies ManualOffsetDragMember;
}

describe("media geometry and crop preservation", () => {
  it("snaps to the canvas even when no other visible object exists", () => {
    const { handlers, gesture } = moveHarness(document.createElement("div"));
    gesture.snapContext!.snapEnabled = true;
    handlers.onPointerMove({ ...pointer(47, 0), altKey: false });
    expect(gesture.lastSnappedDx).toBe(50);
  });

  it("allows off-canvas video movement without adding a crop when snapping is off", () => {
    const { handlers, gesture, setOverlayRect } = moveHarness(
      document.createElement("video"),
    );

    handlers.onPointerMove(pointer(300, 0));

    expect(gesture.lastSnappedDx).toBe(300);
    expect(gesture.selection.element.style.clipPath).toBe("");
    expect(setOverlayRect).toHaveBeenLastCalledWith(
      expect.objectContaining({ left: 1150, top: 250 }),
    );
  });

  it("preserves an explicit crop when dragging beyond the canvas", () => {
    const video = document.createElement("video");
    video.style.clipPath = "inset(0px 50px 0px 0px)";
    const { handlers, gesture, setOverlayRect } = moveHarness(video);

    // Dragging changes position, never the source dimensions or authored crop.
    handlers.onPointerMove(pointer(300, 0));

    expect(gesture.lastSnappedDx).toBe(300);
    expect(video.style.clipPath).toBe("inset(0px 50px 0px 0px)");
    expect(setOverlayRect).toHaveBeenLastCalledWith(
      expect.objectContaining({ left: 1150, top: 250 }),
    );
  });

  it("keeps the imperative drag border aligned with a left-cropped clip's handles", () => {
    const video = document.createElement("video");
    video.style.clipPath = "inset(0px 0px 0px 50px)";
    const { box, handlers, setOverlayRect } = moveHarness(video);

    handlers.onPointerMove(pointer(300, 0));

    // Source x=850 + drag 300 = 1150; adding the explicit 50px crop gives 1200.
    // React positions the handles from that visible x; the imperative fast
    // path must paint the border at the same x in the very same frame.
    expect(setOverlayRect).toHaveBeenLastCalledWith(
      expect.objectContaining({ left: 1150, top: 250 }),
    );
    expect(box.style.left).toBe("1200px");
    expect(box.style.top).toBe("250px");
  });

  it("does not restore the hidden source bounds when a cropped drag is released", () => {
    const video = document.createElement("video");
    video.style.clipPath = "inset(0px 0px 0px 50px)";
    const { box, handlers } = moveHarness(video);
    box.style.left = "900px";
    box.style.top = "250px";

    handlers.onPointerUp(pointer(0, 0));

    // A click-sized drag restores the media transform, but its chrome remains
    // on the visible crop. Writing originLeft here exposes the hidden 50px of
    // source geometry for one frame and makes the border jump independently
    // from its handles.
    expect(box.style.left).toBe("900px");
    expect(box.style.top).toBe("250px");
  });

  it("keeps cropped chrome stable when a moved drag is committed", async () => {
    const video = document.createElement("video");
    video.style.clipPath = "inset(0px 0px 0px 50px)";
    const { box, handlers, gesture } = moveHarness(video);
    enableDragCommit(gesture, video);

    handlers.onPointerMove(pointer(300, 0));
    expect(box.style.left).toBe("1200px");

    handlers.onPointerUp(pointer(300, 0));
    await Promise.resolve();

    // Release must not repaint the full source x=1150 over the visible crop
    // x=1200 while the persisted edit settles.
    expect(box.style.left).toBe("1200px");
    expect(box.style.top).toBe("250px");
  });

  it("does not expand cropped chrome to the source size when resize is cancelled", () => {
    const video = document.createElement("video");
    video.style.clipPath = "inset(10px 20px 30px 40px)";
    const { box, handlers, gesture } = moveHarness(video);
    Object.assign(gesture, {
      kind: "resize",
      mode: "box-size",
      resizeCrop: {
        initial: { top: 10, right: 20, bottom: 30, left: 40 },
        initialInlineValue: "inset(10px 20px 30px 40px)",
        initialInlinePriority: "",
      },
    });
    box.style.left = "890px";
    box.style.top = "260px";
    box.style.width = "40px";
    box.style.height = "60px";

    handlers.onPointerUp(pointer(0, 0));

    expect(box.style.left).toBe("890px");
    expect(box.style.top).toBe("260px");
    expect(box.style.width).toBe("40px");
    expect(box.style.height).toBe("60px");
  });

  it("leaves visible crop chrome untouched when an active drag is interrupted", () => {
    const video = document.createElement("video");
    video.style.clipPath = "inset(0px 0px 0px 50px)";
    const { box, handlers, gesture } = moveHarness(video);
    box.style.left = "900px";
    box.style.top = "250px";

    handlers.clearPointerState(ref<DomEditSelection | null>(gesture.selection));

    expect(box.style.left).toBe("900px");
    expect(box.style.top).toBe("250px");
  });

  it("does not impose the media-only canvas rule on an ordinary design layer", () => {
    const { handlers, gesture, setOverlayRect } = moveHarness(
      document.createElement("div"),
    );

    handlers.onPointerMove(pointer(300, 0));

    expect(gesture.lastSnappedDx).toBe(300);
    expect(setOverlayRect).toHaveBeenLastCalledWith(
      expect.objectContaining({ left: 1150, top: 250 }),
    );
  });

  it("allows an oversized video without silently clipping or capping its source", () => {
    const video = document.createElement("video");
    const { handlers, gesture } = moveHarness(video);
    Object.assign(gesture, {
      kind: "resize",
      mode: "box-size",
      startX: 550,
      startY: 300,
      centerX: 500,
      centerY: 300,
      originLeft: 450,
      originTop: 250,
      originWidth: 100,
      originHeight: 100,
      actualWidth: 100,
      actualHeight: 100,
    });

    // Raw radial scale is 16x (800 / 50). Canvas clipping must not rewrite
    // the media size or add a permanent crop to its source.
    handlers.onPointerMove(pointer(1300, 300));

    expect(readStudioBoxSize(video)).toEqual({ width: 1600, height: 1600 });
    expect(video.style.clipPath).toBe("");
  });
});
