// @vitest-environment happy-dom

import { expect, it } from "vitest";
import { createNativeParameterTrack } from "../../../shared/project/nativeKeyframeTypes";
import { readCropCenterOffsetFraction } from "../canvas/domEditOverlayCrop";
import { nativeCropPivotCorrection, type CropPivotPose } from "./nativeCropPivot";

it("uses the rendered box for a percentage-sized crop in saved and played rotation", () => {
  const element = document.createElement("div");
  element.style.cssText = "width: 50%; height: 50%; clip-path: inset(10px 20px 30px 40px)";
  Object.defineProperty(element, "offsetWidth", { configurable: true, value: 200 });
  Object.defineProperty(element, "offsetHeight", { configurable: true, value: 100 });
  document.body.append(element);
  const fraction = readCropCenterOffsetFraction(element);
  expect(fraction).toEqual({ x: 0.05, y: -0.1 });

  const rotation = createNativeParameterTrack({
    id: "rotation", parameterId: "transform.rotation", valueType: "number",
    frameRate: { numerator: 30, denominator: 1 },
    keyframes: [
      { id: "start", frame: 0, value: 0, outgoing: { type: "linear" } },
      { id: "end", frame: 90, value: 90, outgoing: { type: "linear" } },
    ],
  });
  const poseAt = (frame: number): CropPivotPose => ({
    position: { x: 0, y: -20 * frame / 90 }, rotation: frame,
    scale: { x: 1, y: 1 }, width: null, height: null,
    depth: 0, rotationX: 0, rotationY: 0, perspective: 0, autoRotateDegrees: 0,
  });
  const correction = nativeCropPivotCorrection({
    element, segments: [{ startRotationKeyId: "start", endRotationKeyId: "end", offsetFraction: fraction! }],
    tracks: [rotation], frame: 45, pose: poseAt(45), evaluateAt: poseAt,
  });
  expect(correction?.x).toBeCloseTo(10 - 10 * Math.SQRT2, 8);
  expect(correction?.y).toBeCloseTo(0, 8);
  element.remove();
});
