// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  constrainMediaDragDelta,
  constrainMediaGroupDragDelta,
  constrainMediaResizeSize,
  isCanvasBoundMediaElement,
  rotatedMediaBounds,
} from "./mediaCanvasContainment";

const canvas = { left: 0, top: 0, right: 1000, bottom: 600 };

describe("canvas-bound media geometry", () => {
  it("recognizes visual media without treating ordinary layers or audio as canvas-bound", () => {
    expect(isCanvasBoundMediaElement(document.createElement("video"))).toBe(true);
    expect(isCanvasBoundMediaElement(document.createElement("img"))).toBe(true);
    expect(isCanvasBoundMediaElement(document.createElement("audio"))).toBe(false);
    expect(isCanvasBoundMediaElement(document.createElement("div"))).toBe(false);
  });

  it("clamps a drag against every canvas edge", () => {
    const rect = { left: 100, top: 100, width: 300, height: 200, angle: 0 };

    expect(constrainMediaDragDelta({ rect, canvas, proposed: { dx: -400, dy: -300 } })).toEqual({
      dx: -100,
      dy: -100,
    });
    expect(constrainMediaDragDelta({ rect, canvas, proposed: { dx: 900, dy: 700 } })).toEqual({
      dx: 600,
      dy: 300,
    });
  });

  it("uses the painted bounds of rotated media rather than its unrotated box", () => {
    const bounds = rotatedMediaBounds({
      left: 400,
      top: 250,
      width: 200,
      height: 100,
      angle: 45,
    });
    expect(bounds.left).toBeCloseTo(393.934, 3);
    expect(bounds.right).toBeCloseTo(606.066, 3);
    expect(bounds.top).toBeCloseTo(193.934, 3);
    expect(bounds.bottom).toBeCloseTo(406.066, 3);

    expect(
      constrainMediaDragDelta({
        rect: { left: 400, top: 250, width: 200, height: 100, angle: 45 },
        canvas,
        proposed: { dx: 500, dy: 500 },
      }),
    ).toEqual({
      dx: expect.closeTo(393.934, 3),
      dy: expect.closeTo(193.934, 3),
    });
  });

  it("caps a center-anchored resize to the canvas while preserving aspect ratio", () => {
    const result = constrainMediaResizeSize({
      desired: { width: 1600, height: 900 },
      center: { x: 500, y: 300 },
      angle: 0,
      displayScaleX: 1,
      displayScaleY: 1,
      canvas,
    });

    expect(result.width).toBeCloseTo(1000, 6);
    expect(result.height).toBeCloseTo(562.5, 6);
    expect(result.width / result.height).toBeCloseTo(16 / 9, 6);
  });

  it("accounts for rotation and the media center's available room when resizing", () => {
    const result = constrainMediaResizeSize({
      desired: { width: 800, height: 400 },
      center: { x: 300, y: 300 },
      angle: 90,
      displayScaleX: 1,
      displayScaleY: 1,
      canvas,
    });

    // At 90 degrees the 800px local width becomes the painted height, which
    // must fit the 600px canvas. Both dimensions use the same factor.
    expect(result).toEqual({ width: 600, height: 300 });
  });

  it("centers an already-oversized media box instead of allowing further escape", () => {
    expect(
      constrainMediaDragDelta({
        rect: { left: -200, top: -100, width: 1400, height: 800, angle: 0 },
        canvas,
        proposed: { dx: 300, dy: 200 },
      }),
    ).toEqual({ dx: 0, dy: 0 });
  });

  it("keeps every media member inside the canvas during a group drag", () => {
    expect(
      constrainMediaGroupDragDelta({
        rects: [
          { left: 50, top: 50, width: 100, height: 100, angle: 0 },
          { left: 800, top: 400, width: 150, height: 150, angle: 0 },
        ],
        canvas,
        proposed: { dx: 300, dy: 200 },
      }),
    ).toEqual({ dx: 50, dy: 50 });
  });
});
