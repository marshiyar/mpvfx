import { describe, expect, it } from "vitest";

import { evaluateNativeParameterTrack } from "./nativeKeyframeEvaluator";
import { createNativeParameterTrack } from "./nativeKeyframeTypes";

describe("native keyframe evaluator", () => {
  it("evaluates unwrapped rotation between two keyframes without shortest-path normalization", () => {
    const rotation = createNativeParameterTrack({
      id: "track:rotation",
      parameterId: "transform.rotation",
      valueType: "number",
      frameRate: { numerator: 30, denominator: 1 },
      keyframes: [
        { id: "start", frame: 0, value: 0, outgoing: { type: "linear" } },
        { id: "end", frame: 90, value: -180, outgoing: { type: "linear" } },
      ],
    });

    expect(evaluateNativeParameterTrack(rotation, 45)).toBe(-90);
  });

  it("returns exact endpoint values and clamps before and after the authored range", () => {
    const opacity = createNativeParameterTrack({
      id: "track:opacity",
      parameterId: "transform.opacity",
      valueType: "number",
      frameRate: { numerator: 24, denominator: 1 },
      keyframes: [
        { id: "start", frame: 10, value: 0.25, outgoing: { type: "linear" } },
        { id: "end", frame: 20, value: 0.75, outgoing: { type: "linear" } },
      ],
    });

    expect(evaluateNativeParameterTrack(opacity, 0)).toBe(0.25);
    expect(evaluateNativeParameterTrack(opacity, 10)).toBe(0.25);
    expect(evaluateNativeParameterTrack(opacity, 20)).toBe(0.75);
    expect(evaluateNativeParameterTrack(opacity, 200)).toBe(0.75);
  });

  it("uses the previous keyframe's outgoing hold interpolation for the segment", () => {
    const position = createNativeParameterTrack({
      id: "track:position",
      parameterId: "transform.position",
      valueType: "vec2",
      frameRate: { numerator: 25, denominator: 1 },
      keyframes: [
        {
          id: "start",
          frame: 0,
          value: { x: 10, y: 20 },
          outgoing: { type: "hold" },
        },
        {
          id: "end",
          frame: 25,
          value: { x: 100, y: 200 },
          outgoing: { type: "linear" },
        },
      ],
    });

    expect(evaluateNativeParameterTrack(position, 24)).toEqual({ x: 10, y: 20 });
    expect(evaluateNativeParameterTrack(position, 25)).toEqual({ x: 100, y: 200 });
  });

  it("interpolates vec2 and RGBA values component by component", () => {
    const position = createNativeParameterTrack({
      id: "track:position",
      parameterId: "transform.position",
      valueType: "vec2",
      frameRate: { numerator: 30, denominator: 1 },
      keyframes: [
        { id: "start", frame: 0, value: { x: 0, y: 20 }, outgoing: { type: "linear" } },
        { id: "end", frame: 10, value: { x: 10, y: 40 }, outgoing: { type: "linear" } },
      ],
    });
    const color = createNativeParameterTrack({
      id: "track:color",
      parameterId: "grade.color",
      valueType: "rgba",
      frameRate: { numerator: 30, denominator: 1 },
      keyframes: [
        {
          id: "start",
          frame: 0,
          value: { red: 0, green: 0.2, blue: 0.4, alpha: 0.5 },
          outgoing: { type: "linear" },
        },
        {
          id: "end",
          frame: 10,
          value: { red: 1, green: 0.4, blue: 0.8, alpha: 1 },
          outgoing: { type: "linear" },
        },
      ],
    });

    expect(evaluateNativeParameterTrack(position, 5)).toEqual({ x: 5, y: 30 });
    expect(evaluateNativeParameterTrack(color, 5)).toEqual({
      red: 0.5,
      green: 0.30000000000000004,
      blue: 0.6000000000000001,
      alpha: 0.75,
    });
  });

  it("evaluates cubic-bezier timing from outgoing control points", () => {
    const eased = createNativeParameterTrack({
      id: "track:eased",
      parameterId: "transform.scale",
      valueType: "number",
      frameRate: { numerator: 30, denominator: 1 },
      keyframes: [
        {
          id: "start",
          frame: 0,
          value: 0,
          outgoing: {
            type: "cubic-bezier",
            controlPoints: { x1: 0.42, y1: 0, x2: 1, y2: 1 },
          },
        },
        { id: "end", frame: 100, value: 100, outgoing: { type: "linear" } },
      ],
    });

    expect(evaluateNativeParameterTrack(eased, 50)).toBeCloseTo(31.5357, 3);
  });

  it("is deterministic across repeated and non-monotonic frame evaluation", () => {
    const track = createNativeParameterTrack({
      id: "track:deterministic",
      parameterId: "transform.rotation",
      valueType: "number",
      frameRate: { numerator: 30_000, denominator: 1_001 },
      keyframes: [
        {
          id: "start",
          frame: 0,
          value: 10,
          outgoing: {
            type: "cubic-bezier",
            controlPoints: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
          },
        },
        { id: "end", frame: 120, value: -350, outgoing: { type: "linear" } },
      ],
    });

    const first = evaluateNativeParameterTrack(track, 73);
    expect(evaluateNativeParameterTrack(track, 5)).not.toBe(first);
    expect(evaluateNativeParameterTrack(track, 73)).toBe(first);
    expect(evaluateNativeParameterTrack(track, 73)).toBe(first);
  });

  it("rejects fractional evaluation frames instead of making preview and export disagree", () => {
    const track = createNativeParameterTrack({
      id: "track:integer-time",
      parameterId: "transform.rotation",
      valueType: "number",
      frameRate: { numerator: 30, denominator: 1 },
      keyframes: [
        { id: "start", frame: 0, value: 0, outgoing: { type: "linear" } },
      ],
    });

    expect(() => evaluateNativeParameterTrack(track, 0.5)).toThrow(/integer project frame/i);
  });
});
