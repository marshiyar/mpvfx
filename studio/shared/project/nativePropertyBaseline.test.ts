import { describe, expect, it } from "vitest";
import { readNativePropertyBaselines } from "./nativePropertyBaseline";

describe("native property baselines", () => {
  it("decomposes the selected element's existing CSS matrix before the first keyframe", () => {
    const radians = (25 * Math.PI) / 180;
    const transform = `matrix(${1.2 * Math.cos(radians)}, ${1.2 * Math.sin(radians)}, ${
      -0.8 * Math.sin(radians)
    }, ${0.8 * Math.cos(radians)}, 40, -12)`;

    const result = readNativePropertyBaselines({
      computedStyles: {
        transform,
        opacity: "0.65",
        width: "640px",
        height: "360px",
      },
      boundingBox: { width: 600, height: 320 },
    });

    expect(result.x).toBeCloseTo(40, 8);
    expect(result.y).toBeCloseTo(-12, 8);
    expect(result.rotation).toBeCloseTo(25, 8);
    expect(result.rotationZ).toBeCloseTo(25, 8);
    expect(result.scaleX).toBeCloseTo(1.2, 8);
    expect(result.scaleY).toBeCloseTo(0.8, 8);
    expect(result.scale).toBeUndefined();
    expect(result.opacity).toBeCloseTo(0.65, 8);
    expect(result.autoAlpha).toBeCloseTo(0.65, 8);
    expect(result.width).toBe(640);
    expect(result.height).toBe(360);
  });

  it("recognizes an identity transform and uniform scale without inventing motion", () => {
    expect(
      readNativePropertyBaselines({
        computedStyles: { transform: "matrix(2, 0, 0, 2, 0, 0)" },
        boundingBox: { width: 100, height: 50 },
      }),
    ).toMatchObject({
      x: 0,
      y: 0,
      rotation: 0,
      scale: 2,
      scaleX: 2,
      scaleY: 2,
      width: 100,
      height: 50,
    });
  });

  it("uses finite measured dimensions but omits malformed style values", () => {
    const result = readNativePropertyBaselines({
      computedStyles: {
        transform: "not-a-matrix",
        opacity: "NaN",
        width: "auto",
        height: "0px",
      },
      boundingBox: { width: 320, height: 180 },
    });

    expect(result).toEqual({ width: 320, height: 180 });
  });

  it("reads CSS individual translate, rotate, and scale properties used by manual edits", () => {
    expect(
      readNativePropertyBaselines({
        computedStyles: {
          transform: "none",
          translate: "12px -8px",
          rotate: "25deg",
          scale: "1.25 0.8",
        },
        boundingBox: { width: 640, height: 360 },
      }),
    ).toMatchObject({
      x: 12,
      y: -8,
      rotation: 25,
      rotationZ: 25,
      scaleX: 1.25,
      scaleY: 0.8,
    });
  });
});
