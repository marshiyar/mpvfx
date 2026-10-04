// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { createDomEditOverlayGestureHandlers } from "../useDomEditOverlayGestures";
import type { DomEditSelection } from "../domEditing";
import type {
  GestureState,
  UseDomEditOverlayGesturesOptions,
} from "../domEditOverlayGestures";
import { createManualOffsetDragMember, type ManualOffsetDragMember } from "../manualOffsetDrag";
import { readStudioBoxSize } from "../manualEdits";
import { applyNativeGestureDraft } from "../../project/nativeGestureDraft";
import { STUDIO_MANUAL_EDIT_GESTURE_ATTR } from "../manualEditsTypes";

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
    opts,
    handlers: createDomEditOverlayGestureHandlers(opts),
    gesture,
    setOverlayRect,
  };
}

describe("rotation gesture termination", () => {
  it("moves the hidden source so an asymmetric crop rotates around its visible center", async () => {
    const element = document.createElement("div");
    const { handlers, gesture, opts, setOverlayRect } = moveHarness(element);
    enableDragCommit(gesture, element);
    Object.assign(gesture, {
      kind: "rotate", mode: "rotation", actualRotation: 0,
      centerX: 0, centerY: 0, startX: 100, startY: 0,
      rotationVisibleOffset: { x: 10, y: 0 },
    });
    handlers.onPointerMove(pointer(0, 100));
    expect(setOverlayRect).toHaveBeenLastCalledWith(expect.objectContaining({
      left: 860, top: 240, angle: 90,
    }));
    handlers.onPointerUp(pointer(0, 100));
    expect(opts.onRotationCommitRef.current).toHaveBeenCalledWith(
      gesture.selection, { angle: 90 }, { x: 10, y: -10 },
    );
    await Promise.resolve();
  });

  it("keeps a native CSS rotation draft through a stale frame repaint", () => {
    const element = document.createElement("div");
    element.setAttribute("data-studio-native-owned", "transform.rotation");
    element.setAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR, "rotate-test");
    const { handlers, gesture, setOverlayRect } = moveHarness(element);
    Object.assign(gesture, {
      kind: "rotate", mode: "rotation", actualRotation: 0,
      centerX: 0, centerY: 0, startX: 100, startY: 0,
    });

    handlers.onPointerMove(pointer(0, 100));
    expect(setOverlayRect).toHaveBeenLastCalledWith(expect.objectContaining({
      left: 850, top: 250, width: 100, height: 100, angle: 90,
    }));
    const draft = element.style.rotate;
    expect(draft).toContain("90deg");
    element.style.rotate = "0deg";
    applyNativeGestureDraft(element);
    expect(element.style.rotate).toBe(draft);
  });

  it("cancels a move through its durable member baseline after the DOM baseline was consumed", () => {
    const element = document.createElement("div");
    const { handlers, gesture, opts } = moveHarness(element);
    const set = vi.fn();
    vi.stubGlobal("gsap", { set, getProperty: (_el: Element, prop: string) => prop === "x" ? 270 : 242 });
    try {
      const result = createManualOffsetDragMember({ key: "clip", element, selection: gesture.selection,
        rect: { left: 270, top: 242, width: 100, height: 100, editScaleX: 1, editScaleY: 1 } });
      if (!result.ok) throw new Error("Failed to start gesture");
      gesture.pathOffsetMember = result.member;
      gesture.initialPathOffset = result.member.initialPathOffset;
      gesture.manualEditDragToken = result.member.gestureToken;
      handlers.onPointerMove(pointer(30, -46));
      set.mockClear();

      handlers.clearPointerState(opts.selectionRef);
      handlers.onPointerUp(pointer(30, -46));

      expect(set).toHaveBeenLastCalledWith(element, { x: 270, y: 242 });
      expect(opts.onPathOffsetCommitRef.current).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("restores the actual GSAP angle on cancellation and cannot commit after release", () => {
    const element = document.createElement("div");
    const { handlers, gesture, opts } = moveHarness(element);
    Object.assign(gesture, { kind: "rotate", mode: "rotation", actualRotation: 12 });
    const set = vi.fn();
    vi.stubGlobal("gsap", { set, getProperty: () => 12 });
    try {
      handlers.onPointerMove(pointer(20, 50));
      expect(set).toHaveBeenCalled();
      handlers.clearPointerState(opts.selectionRef);
      expect(set).toHaveBeenLastCalledWith(element, { rotation: 12 });
      handlers.onPointerUp(pointer(20, 50));
      expect(opts.onRotationCommitRef.current).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("commits the displayed snapped angle if Shift is released without another pointer move", () => {
    const element = document.createElement("div");
    const { handlers, gesture, opts } = moveHarness(element);
    Object.assign(gesture, { kind: "rotate", mode: "rotation", actualRotation: 0,
      centerX: 0, centerY: 0, startX: 100, startY: 0 });
    const move = { ...pointer(100, 20), shiftKey: true };
    handlers.onPointerMove(move);
    handlers.onPointerUp(pointer(100, 20));
    expect(opts.onRotationCommitRef.current).toHaveBeenCalledWith(gesture.selection, { angle: 15 });
  });
});

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

describe("media gestures beyond the canvas", () => {
  it("snaps to the canvas even when no other visible object exists", () => {
    const { handlers, gesture } = moveHarness(document.createElement("div"));
    gesture.snapContext!.snapEnabled = true;
    handlers.onPointerMove({ ...pointer(47, 0), altKey: false });
    expect(gesture.lastSnappedDx).toBe(50);
  });

  it("allows a video to cross the canvas edge when snapping is off and Alt is held", () => {
    const { handlers, gesture, setOverlayRect } = moveHarness(
      document.createElement("video"),
    );

    handlers.onPointerMove(pointer(300, 0));

    expect(gesture.lastSnappedDx).toBe(300);
    expect(setOverlayRect).toHaveBeenLastCalledWith(
      expect.objectContaining({ left: 1150, top: 250 }),
    );
  });

  it("allows a cropped video beyond the canvas without clamping its source or visible edge", () => {
    const video = document.createElement("video");
    video.style.clipPath = "inset(0px 50px 0px 0px)";
    const { handlers, gesture, setOverlayRect } = moveHarness(video);

    // Cropping changes the visible geometry, not the allowed drag distance.
    handlers.onPointerMove(pointer(300, 0));

    expect(gesture.lastSnappedDx).toBe(300);
    expect(setOverlayRect).toHaveBeenLastCalledWith(
      expect.objectContaining({ left: 1150, top: 250 }),
    );
  });

  it("keeps the imperative drag border aligned with a left-cropped clip's handles", () => {
    const video = document.createElement("video");
    video.style.clipPath = "inset(0px 0px 0px 50px)";
    const { box, handlers, setOverlayRect } = moveHarness(video);

    handlers.onPointerMove(pointer(300, 0));

    // The source box moves to x=1150, while its visible crop begins at x=1200.
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

    // Release must keep the visible crop at x=1200 while the persisted edit settles.
    expect(box.style.left).toBe("1200px");
    expect(box.style.top).toBe("250px");
    expect(gesture.lastSnappedDx).toBe(300);
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

  it("also allows an ordinary design layer beyond the canvas", () => {
    const { handlers, gesture, setOverlayRect } = moveHarness(
      document.createElement("div"),
    );

    handlers.onPointerMove(pointer(300, 0));

    expect(gesture.lastSnappedDx).toBe(300);
    expect(setOverlayRect).toHaveBeenLastCalledWith(
      expect.objectContaining({ left: 1150, top: 250 }),
    );
  });

  it("allows a video resize beyond the canvas before the draft is committed", () => {
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

    // A 16x radial scale (800 / 50) is allowed beyond the 600px-tall canvas.
    handlers.onPointerMove(pointer(1300, 300));

    expect(readStudioBoxSize(video)).toEqual({ width: 1600, height: 1600 });
  });
});
