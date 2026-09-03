import { describe, expect, it } from "vitest";
import {
  resolveLinkedCropInsets,
  cropRectFromInsets,
  hugRectForElement,
  hugOrientedRectForElement,
  readElementCropFrame,
  readElementCropInsets,
  resolveCropInsetFromEdgeDrag,
  rotateDeltaIntoFrame,
  scaleCropInsetsForBoxResize,
} from "./domEditOverlayCrop";
import { individualRotateDegrees } from "./domEditOverlayTransform";

describe("resolveCropInsetFromEdgeDrag", () => {
  const startInsets = { top: 10, right: 20, bottom: 30, left: 40 };

  it("converts overlay-space edge movement into element-space inset changes", () => {
    expect(
      resolveCropInsetFromEdgeDrag({
        edge: "left",
        startInsets,
        deltaX: 20,
        deltaY: 0,
        scaleX: 2,
        scaleY: 1,
        width: 200,
        height: 120,
      }),
    ).toEqual({ top: 10, right: 20, bottom: 30, left: 50 });

    expect(
      resolveCropInsetFromEdgeDrag({
        edge: "right",
        startInsets,
        deltaX: 20,
        deltaY: 0,
        scaleX: 2,
        scaleY: 1,
        width: 200,
        height: 120,
      }),
    ).toEqual({ top: 10, right: 10, bottom: 30, left: 40 });
  });

  it("clamps edited insets so opposing sides never overlap", () => {
    expect(
      resolveCropInsetFromEdgeDrag({
        edge: "left",
        startInsets,
        deltaX: 400,
        deltaY: 0,
        scaleX: 1,
        scaleY: 1,
        width: 100,
        height: 120,
      }),
    ).toEqual({ top: 10, right: 20, bottom: 30, left: 80 });

    expect(
      resolveCropInsetFromEdgeDrag({
        edge: "top",
        startInsets,
        deltaX: 0,
        deltaY: -40,
        scaleX: 1,
        scaleY: 2,
        width: 200,
        height: 120,
      }),
    ).toEqual({ top: 0, right: 20, bottom: 30, left: 40 });
  });
});

describe("resolveLinkedCropInsets", () => {
  const insets = { top: 10, right: 20, bottom: 30, left: 40 };

  it("updates only the dragged edge when every link is off", () => {
    expect(
      resolveLinkedCropInsets({
        insets,
        edge: "top",
        value: 15,
        links: { all: false, vertical: false, horizontal: false },
      }),
    ).toEqual({ top: 15, right: 20, bottom: 30, left: 40 });
  });

  it("clamps an independent edge before it can cross its opposite edge", () => {
    expect(
      resolveLinkedCropInsets({
        insets,
        edge: "left",
        value: 190,
        links: { all: false, vertical: false, horizontal: false },
        width: 200,
        height: 100,
      }),
    ).toEqual({ top: 10, right: 20, bottom: 30, left: 180 });
    expect(
      resolveLinkedCropInsets({
        insets,
        edge: "top",
        value: 90,
        links: { all: false, vertical: false, horizontal: false },
        width: 200,
        height: 100,
      }),
    ).toEqual({ top: 70, right: 20, bottom: 30, left: 40 });
  });

  it("links top and bottom without changing left or right", () => {
    expect(
      resolveLinkedCropInsets({
        insets,
        edge: "bottom",
        value: 18,
        links: { all: false, vertical: true, horizontal: false },
      }),
    ).toEqual({ top: 18, right: 20, bottom: 18, left: 40 });
  });

  it("links left and right without changing top or bottom", () => {
    expect(
      resolveLinkedCropInsets({
        insets,
        edge: "left",
        value: 12,
        links: { all: false, vertical: false, horizontal: true },
      }),
    ).toEqual({ top: 10, right: 12, bottom: 30, left: 12 });
  });

  it("links all four edges and clamps to half the smaller media dimension", () => {
    expect(
      resolveLinkedCropInsets({
        insets,
        edge: "right",
        value: 90,
        links: { all: true, vertical: false, horizontal: false },
        width: 200,
        height: 100,
      }),
    ).toEqual({ top: 50, right: 50, bottom: 50, left: 50 });
  });

  it("clamps linked edge pairs without collapsing their axis", () => {
    expect(
      resolveLinkedCropInsets({
        insets,
        edge: "top",
        value: 80,
        links: { all: false, vertical: true, horizontal: false },
        width: 200,
        height: 100,
      }),
    ).toEqual({ top: 50, right: 20, bottom: 50, left: 40 });
    expect(
      resolveLinkedCropInsets({
        insets,
        edge: "right",
        value: 120,
        links: { all: false, vertical: false, horizontal: true },
        width: 200,
        height: 100,
      }),
    ).toEqual({ top: 10, right: 100, bottom: 30, left: 100 });
  });
});

describe("cropRectFromInsets", () => {
  it("shrinks the overlay rect by scaled insets", () => {
    expect(
      cropRectFromInsets(
        { left: 100, top: 50, width: 200, height: 100 },
        { top: 10, right: 40, bottom: 20, left: 30 },
        2,
        1,
      ),
    ).toEqual({ left: 160, top: 60, width: 60, height: 70 });
  });

  it("clamps to zero size when insets exceed the rect", () => {
    const r = cropRectFromInsets(
      { left: 0, top: 0, width: 100, height: 100 },
      { top: 300, right: 300, bottom: 300, left: 300 },
      1,
      1,
    );
    expect(r.width).toBe(0);
    expect(r.height).toBe(0);
  });
});

describe("scaleCropInsetsForBoxResize", () => {
  it("scales every crop margin with the resized source box", () => {
    const initial = { top: 10, right: 20, bottom: 30, left: 40 };
    const scaled = scaleCropInsetsForBoxResize({
      insets: initial,
      from: { width: 200, height: 100 },
      to: { width: 400, height: 200 },
    });

    expect(scaled).toEqual({ top: 20, right: 40, bottom: 60, left: 80 });
    expect(400 - scaled.left - scaled.right).toBe(
      2 * (200 - initial.left - initial.right),
    );
    expect(200 - scaled.top - scaled.bottom).toBe(
      2 * (100 - initial.top - initial.bottom),
    );
  });
});

describe("hugOrientedRectForElement", () => {
  const croppedMedia = (clipPath: string) =>
    ({
      style: {
        getPropertyValue: (property: string) =>
          property === "clip-path" ? clipPath : "",
      },
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ clipPath: "none" }) },
      },
    }) as unknown as HTMLElement;

  it("makes an asymmetric crop the visible bounds of an unrotated media file", () => {
    const element = croppedMedia("inset(10px 20px 30px 40px)");

    expect(
      hugOrientedRectForElement(
        {
          left: 100,
          top: 50,
          width: 200,
          height: 100,
          editScaleX: 1,
          editScaleY: 1,
          angle: 0,
        },
        element,
      ),
    ).toEqual({
      left: 140,
      top: 60,
      width: 140,
      height: 60,
      editScaleX: 1,
      editScaleY: 1,
      angle: 0,
    });
  });

  it("rotates an asymmetric crop offset around the original media center", () => {
    const element = croppedMedia("inset(10px 20px 30px 40px)");

    expect(
      hugOrientedRectForElement(
        {
          left: 100,
          top: 50,
          width: 200,
          height: 100,
          editScaleX: 1,
          editScaleY: 1,
          angle: 90,
        },
        element,
      ),
    ).toEqual({
      // Crop-local center offset is (10, -10). At 90 degrees that becomes
      // (10, 10) in the overlay, relative to the full media center (200, 100).
      left: 140,
      top: 80,
      width: 140,
      height: 60,
      editScaleX: 1,
      editScaleY: 1,
      angle: 90,
    });
  });

  it("keeps crop margins attached after the media has been scaled", () => {
    const element = {
      ...croppedMedia("inset(10px 20px 30px 40px)"),
      offsetWidth: 200,
      offsetHeight: 100,
      parentElement: null,
      hasAttribute: () => false,
      ownerDocument: {
        defaultView: {
          getComputedStyle: () => ({
            clipPath: "inset(10px 20px 30px 40px)",
            transform: "matrix(2, 0, 0, 2, 0, 0)",
            rotate: "none",
          }),
        },
      },
    } as unknown as HTMLElement;

    expect(
      hugOrientedRectForElement(
        {
          left: 100,
          top: 50,
          width: 400,
          height: 200,
          editScaleX: 1,
          editScaleY: 1,
          angle: 0,
        },
        element,
      ),
    ).toEqual({
      left: 180,
      top: 70,
      width: 280,
      height: 120,
      editScaleX: 1,
      editScaleY: 1,
      angle: 0,
    });
  });
});

describe("readElementCropInsets tri-state", () => {
  // Regression: a clip-path the crop tool can't represent (circle/polygon/
  // non-px inset) used to parse to ZEROS — indistinguishable from "no crop" —
  // so selecting lifted the clip and deselecting removed/replaced it: the
  // authored circle clip was silently destroyed by a mere select+deselect.
  const fakeEl = (inlineClip: string) =>
    ({
      style: {
        getPropertyValue: (p: string) => (p === "clip-path" ? inlineClip : ""),
      },
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ clipPath: "none" }) },
      },
    }) as unknown as HTMLElement;

  it("zeros for no clip", () => {
    expect(readElementCropInsets(fakeEl(""))).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      radius: 0,
    });
  });

  it("parses a px inset", () => {
    expect(readElementCropInsets(fakeEl("inset(16px round 12px)"))).toEqual({
      top: 16,
      right: 16,
      bottom: 16,
      left: 16,
      radius: 12,
    });
  });

  it("null for a circle clip (uneditable, must not be lifted)", () => {
    expect(readElementCropInsets(fakeEl("circle(50% at 50% 50%)"))).toBeNull();
  });

  it("null for a non-px inset (uneditable, must not be lifted)", () => {
    expect(readElementCropInsets(fakeEl("inset(10%)"))).toBeNull();
  });

  it("hugRectForElement passes the rect through for uneditable clips", () => {
    const rect = {
      left: 1,
      top: 2,
      width: 30,
      height: 40,
      editScaleX: 1,
      editScaleY: 1,
    };
    expect(hugRectForElement(rect, fakeEl("circle(50%)"))).toEqual(rect);
  });
});

// Regression: crop UI drawn on the axis-aligned bounding box visually
// "straightens" a rotated element — the dim masks the rotated corners. The
// frame gives the element's own box + rotation so the UI rotates with it.
describe("readElementCropFrame", () => {
  const overlayRect = {
    left: 100,
    top: 50,
    width: 220,
    height: 130,
    editScaleX: 1,
    editScaleY: 1,
  };

  // Models an element well enough for the ancestor walk: it reports its own
  // transform, claims no composition-root attribute, and has no parent, so the
  // walk composes exactly one node.
  const fakeEl = (transform: string, offsetWidth = 200, offsetHeight = 100) =>
    ({
      offsetWidth,
      offsetHeight,
      parentElement: null,
      hasAttribute: () => false,
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ transform }) },
      },
    }) as unknown as HTMLElement;

  it("identity transform → the axis-aligned overlay rect", () => {
    expect(readElementCropFrame(fakeEl("none"), overlayRect)).toEqual({
      angleDeg: 0,
      left: 100,
      top: 50,
      width: 220,
      height: 130,
      scaleX: 1,
      scaleY: 1,
    });
  });

  it("rotated element → its own box, centered on the AABB, with the angle", () => {
    // rotate(30deg): matrix(cos, sin, -sin, cos, tx, ty)
    const cos = Math.cos(Math.PI / 6);
    const sin = Math.sin(Math.PI / 6);
    const frame = readElementCropFrame(
      fakeEl(`matrix(${cos}, ${sin}, ${-sin}, ${cos}, 10, 20)`),
      overlayRect,
    );
    expect(frame.angleDeg).toBeCloseTo(30, 3);
    expect(frame.width).toBeCloseTo(200, 3);
    expect(frame.height).toBeCloseTo(100, 3);
    // centered on the AABB center (210, 115)
    expect(frame.left + frame.width / 2).toBeCloseTo(210, 3);
    expect(frame.top + frame.height / 2).toBeCloseTo(115, 3);
    expect(frame.scaleX).toBeCloseTo(1, 3);
  });

  it("scaled element → scale factored into px-per-element-px", () => {
    const frame = readElementCropFrame(
      fakeEl("matrix(1.5, 0, 0, 2, 0, 0)"),
      overlayRect,
    );
    expect(frame.angleDeg).toBe(0);
    expect(frame.scaleX).toBeCloseTo(1.5, 3);
    expect(frame.scaleY).toBeCloseTo(2, 3);
    expect(frame.width).toBeCloseTo(300, 3);
    expect(frame.height).toBeCloseTo(200, 3);
  });

  /**
   * A 3D matrix is not automatically unmeasurable. GSAP writes one for an
   * ordinary 2D move or spin (force3D), so refusing every `matrix3d` drew the
   * crop outline square on elements the rest of the chrome drew rotated.
   * The identity here is a 2D transform written the long way.
   */
  it("reads a planar matrix3d rather than giving up on it", () => {
    // scale(1.5, 2) written the long way — planar, and not the identity.
    const frame = readElementCropFrame(
      fakeEl("matrix3d(1.5,0,0,0,0,2,0,0,0,0,1,0,0,0,0,1)"),
      overlayRect,
    );
    expect(frame.scaleX).toBeCloseTo(1.5, 3);
    expect(frame.scaleY).toBeCloseTo(2, 3);
  });

  it("reads a 2D rotation written as matrix3d", () => {
    const frame = readElementCropFrame(
      fakeEl("matrix3d(0.866025,0.5,0,0,-0.5,0.866025,0,0,0,0,1,0,0,0,0,1)"),
      overlayRect,
    );
    expect(frame.angleDeg).toBeCloseTo(30, 3);
  });

  it("reads a flipped element, which still has a real size", () => {
    // Negative z scale — a composition that mirrors an element writes this.
    const frame = readElementCropFrame(
      fakeEl("matrix3d(-0.866025,-0.5,0,0,-0.5,0.866025,0,0,0,0,-1,0,0,0,0,1)"),
      overlayRect,
    );
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBeGreaterThan(0);
  });

  it("still falls back on a perspective transform, which no single angle describes", () => {
    const frame = readElementCropFrame(
      fakeEl("matrix3d(1,0,0,0.002,0,1,0,0,0,0,1,0,0,0,0,1)"),
      overlayRect,
    );
    expect(frame).toEqual({
      angleDeg: 0,
      left: 100,
      top: 50,
      width: 220,
      height: 130,
      scaleX: 1,
      scaleY: 1,
    });
  });
});

describe("rotateDeltaIntoFrame", () => {
  it("passes deltas through at 0deg", () => {
    expect(rotateDeltaIntoFrame(10, 5, 0)).toEqual({ deltaX: 10, deltaY: 5 });
  });

  it("rotates a screen delta into a 90deg-rotated frame", () => {
    // Element rotated +90°: dragging DOWN on screen moves along the element's +x.
    const { deltaX, deltaY } = rotateDeltaIntoFrame(0, 10, 90);
    expect(deltaX).toBeCloseTo(10, 6);
    expect(deltaY).toBeCloseTo(0, 6);
  });

  it("round-trips a 30deg rotation", () => {
    const local = rotateDeltaIntoFrame(7, -3, 30);
    const back = rotateDeltaIntoFrame(local.deltaX, local.deltaY, -30);
    expect(back.deltaX).toBeCloseTo(7, 6);
    expect(back.deltaY).toBeCloseTo(-3, 6);
  });
});

describe("individualRotateDegrees", () => {
  /**
   * Studio's rotate handle writes the CSS `rotate` property, not `transform`.
   * Everything that measured an element's angle read `transform` alone, so a
   * turned element reported upright and the selection box, crop outline and
   * child outlines all drew square across it.
   */
  it("reads a plain angle", () => {
    expect(individualRotateDegrees("-22deg")).toBeCloseTo(-22, 6);
    expect(individualRotateDegrees("45deg")).toBeCloseTo(45, 6);
  });

  it("reads an explicit z-axis rotation, honouring the axis sign", () => {
    expect(individualRotateDegrees("0 0 1 30deg")).toBeCloseTo(30, 6);
    expect(individualRotateDegrees("0 0 -1 30deg")).toBeCloseTo(-30, 6);
  });

  it("reports nothing for a rotation that leaves the overlay's plane", () => {
    // A 3D turn has no single in-plane angle. Reporting one would draw the
    // chrome at a plausible-looking wrong angle instead of falling back square.
    expect(individualRotateDegrees("1 0 0 45deg")).toBe(0);
    expect(individualRotateDegrees("0 1 0 45deg")).toBe(0);
  });

  it("reports nothing when the property is absent or unparseable", () => {
    expect(individualRotateDegrees("none")).toBe(0);
    expect(individualRotateDegrees(undefined)).toBe(0);
    expect(individualRotateDegrees("")).toBe(0);
    expect(individualRotateDegrees("12")).toBe(0);
  });
});

describe("readElementCropFrame — the composed walk", () => {
  /**
   * The case the crop outline got wrong: a text layer inside a rotated card.
   * The layer carries its own spin and its parent turns it again, so the box
   * belongs at the combination. Reading the element alone drew it across the
   * text at roughly a right angle.
   */
  const nested = (childTransform: string, parentTransform: string) => {
    const style = (transform: string) => ({ transform }) as CSSStyleDeclaration;
    const parent = {
      offsetWidth: 400,
      offsetHeight: 300,
      parentElement: null,
      hasAttribute: (name: string) => name === "data-composition-id",
      ownerDocument: {
        defaultView: { getComputedStyle: () => style(parentTransform) },
      },
    };
    return {
      offsetWidth: 200,
      offsetHeight: 100,
      parentElement: parent,
      hasAttribute: () => false,
      ownerDocument: {
        defaultView: {
          getComputedStyle: (node: unknown) =>
            node === parent ? style(parentTransform) : style(childTransform),
        },
      },
    } as unknown as HTMLElement;
  };

  const overlayRect = {
    left: 100,
    top: 50,
    width: 220,
    height: 130,
    editScaleX: 1,
    editScaleY: 1,
  };

  it("adds the parent's rotation to the child's", () => {
    // child 30deg inside a parent turned 60deg → the layer paints at 90.
    const frame = readElementCropFrame(
      nested(
        "matrix(0.8660254, 0.5, -0.5, 0.8660254, 0, 0)",
        "matrix(0.5, 0.8660254, -0.8660254, 0.5, 0, 0)",
      ),
      overlayRect,
    );
    expect(frame.angleDeg).toBeCloseTo(90, 3);
  });

  it("takes the parent's rotation when the child has none of its own", () => {
    const frame = readElementCropFrame(
      nested("none", "matrix(0.8660254, 0.5, -0.5, 0.8660254, 0, 0)"),
      overlayRect,
    );
    expect(frame.angleDeg).toBeCloseTo(30, 3);
  });

  it("stops at the composition root rather than walking the whole document", () => {
    // The root itself is marked, so its own transform is the last one counted.
    const frame = readElementCropFrame(
      nested("none", "matrix(0.8660254, 0.5, -0.5, 0.8660254, 0, 0)"),
      overlayRect,
    );
    expect(frame.angleDeg).toBeCloseTo(30, 3);
  });
});
