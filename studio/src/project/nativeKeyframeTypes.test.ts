import { describe, expect, it } from "vitest";

import {
  NATIVE_KEYFRAME_SCHEMA_VERSION,
  NativeKeyframeValidationError,
  createNativeParameterTrack,
  validateRationalFrameRate,
} from "./nativeKeyframeTypes";

describe("native keyframe track types", () => {
  it("creates a versioned typed track and deterministically orders keyframes by project frame", () => {
    const track = createNativeParameterTrack({
      id: "track:clip-1:rotation",
      parameterId: "transform.rotation",
      valueType: "number",
      frameRate: { numerator: 30_000, denominator: 1_001 },
      keyframes: [
        { id: "key:end", frame: 90, value: -180, outgoing: { type: "linear" } },
        { id: "key:start", frame: 0, value: 0, outgoing: { type: "linear" } },
      ],
    });

    expect(track.schemaVersion).toBe(NATIVE_KEYFRAME_SCHEMA_VERSION);
    expect(track.id).toBe("track:clip-1:rotation");
    expect(track.parameterId).toBe("transform.rotation");
    expect(track.valueType).toBe("number");
    expect(track.keyframes.map((keyframe) => keyframe.id)).toEqual(["key:start", "key:end"]);
  });

  it.each([
    [{ numerator: 0, denominator: 1 }, "numerator"],
    [{ numerator: 30, denominator: 0 }, "denominator"],
    [{ numerator: 29.97, denominator: 1 }, "integer"],
    [{ numerator: 30, denominator: 1.5 }, "integer"],
  ] as const)("rejects invalid rational frame rate %j", (frameRate, expectedMessage) => {
    expect(() => validateRationalFrameRate(frameRate)).toThrow(expectedMessage);
  });

  it("rejects ambiguous duplicate keyframe IDs", () => {
    expect(() =>
      createNativeParameterTrack({
        id: "track:opacity",
        parameterId: "transform.opacity",
        valueType: "number",
        frameRate: { numerator: 24, denominator: 1 },
        keyframes: [
          { id: "same", frame: 0, value: 0, outgoing: { type: "linear" } },
          { id: "same", frame: 12, value: 1, outgoing: { type: "linear" } },
        ],
      }),
    ).toThrowError(NativeKeyframeValidationError);
  });

  it("rejects ambiguous duplicate keyframe times", () => {
    expect(() =>
      createNativeParameterTrack({
        id: "track:position",
        parameterId: "transform.position",
        valueType: "vec2",
        frameRate: { numerator: 60, denominator: 1 },
        keyframes: [
          { id: "left", frame: 15, value: { x: 0, y: 0 }, outgoing: { type: "linear" } },
          { id: "right", frame: 15, value: { x: 10, y: 10 }, outgoing: { type: "linear" } },
        ],
      }),
    ).toThrow(/duplicate keyframe frame 15/i);
  });

  it("rejects non-integer project-frame times instead of silently rounding", () => {
    expect(() =>
      createNativeParameterTrack({
        id: "track:rotation",
        parameterId: "transform.rotation",
        valueType: "number",
        frameRate: { numerator: 30, denominator: 1 },
        keyframes: [
          { id: "fractional", frame: 1.5, value: 90, outgoing: { type: "linear" } },
        ],
      }),
    ).toThrow(/integer project frame/i);
  });

  it("validates numeric, vec2, and RGBA values against the declared track type", () => {
    expect(() =>
      createNativeParameterTrack({
        id: "track:bad-color",
        parameterId: "grade.tint",
        valueType: "rgba",
        frameRate: { numerator: 30, denominator: 1 },
        keyframes: [
          {
            id: "bad",
            frame: 0,
            value: { red: 1, green: 0.5, blue: 0.25, alpha: 2 },
            outgoing: { type: "linear" },
          },
        ],
      }),
    ).toThrow(/alpha/i);

    expect(() =>
      createNativeParameterTrack({
        id: "track:bad-vector",
        parameterId: "transform.position",
        valueType: "vec2",
        frameRate: { numerator: 30, denominator: 1 },
        keyframes: [
          {
            id: "bad",
            frame: 0,
            value: { x: Number.NaN, y: 0 },
            outgoing: { type: "linear" },
          },
        ],
      }),
    ).toThrow(/finite/i);
  });

  it("validates cubic-bezier control points on the outgoing segment", () => {
    expect(() =>
      createNativeParameterTrack({
        id: "track:eased",
        parameterId: "transform.scale",
        valueType: "number",
        frameRate: { numerator: 30, denominator: 1 },
        keyframes: [
          {
            id: "start",
            frame: 0,
            value: 1,
            outgoing: {
              type: "cubic-bezier",
              controlPoints: { x1: -0.1, y1: 0, x2: 1, y2: 1 },
            },
          },
        ],
      }),
    ).toThrow(/x1/i);
  });
});
