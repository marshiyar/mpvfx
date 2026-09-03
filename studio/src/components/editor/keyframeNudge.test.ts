import { describe, expect, it } from "vitest";
import { planKeyframeNudge } from "./keyframeNudge";

describe("planKeyframeNudge", () => {
  it("moves a long-tween keyframe by exactly one rendered frame", () => {
    const result = planKeyframeNudge({
      keyframePercentages: [0, 50, 100],
      selectedPercentages: [50],
      tweenStart: 0,
      tweenDuration: 120,
      direction: 1,
      frameCount: 1,
    });

    expect(result).toMatchObject({ kind: "move", deltaFrames: 1 });
    expect(result.moves).toHaveLength(1);
    expect(result.moves?.[0]).toMatchObject({ from: 50 });
    expect(result.moves?.[0]?.to).toBeCloseTo(50.0277777778, 9);
  });

  it("moves every selected key together without changing relative timing", () => {
    const result = planKeyframeNudge({
      keyframePercentages: [0, 20, 40, 100],
      selectedPercentages: [20, 40],
      tweenStart: 2,
      tweenDuration: 10,
      direction: 1,
      frameCount: 10,
    });

    expect(result).toMatchObject({ kind: "move", deltaFrames: 10 });
    expect(result.moves?.map(({ from }) => from)).toEqual([20, 40]);
    const [first, second] = result.moves ?? [];
    expect((second?.to ?? 0) - (first?.to ?? 0)).toBeCloseTo(20, 9);
  });

  it("clamps the whole group before an unselected neighbor frame", () => {
    const result = planKeyframeNudge({
      keyframePercentages: [0, 50, 50.0555555556, 100],
      selectedPercentages: [50],
      tweenStart: 0,
      tweenDuration: 120,
      direction: 1,
      frameCount: 10,
    });

    // The unselected key is two frames later, so one frame is the furthest safe
    // group move. It must not collide with or jump across that neighbor.
    expect(result).toMatchObject({ kind: "move", deltaFrames: 1 });
    expect(result.moves?.[0]?.to).toBeCloseTo(50.0277777778, 9);
  });

  it("is a no-op when the neighboring rendered frame is already occupied", () => {
    const result = planKeyframeNudge({
      keyframePercentages: [0, 50, 50.0277777778, 100],
      selectedPercentages: [50],
      tweenStart: 0,
      tweenDuration: 120,
      direction: 1,
      frameCount: 1,
    });

    expect(result).toEqual({ kind: "noop", moves: [], deltaFrames: 0 });
  });

  it("rejects ambiguous source keys that already share an output frame", () => {
    const result = planKeyframeNudge({
      keyframePercentages: [50, 50.001],
      selectedPercentages: [50],
      tweenStart: 0,
      tweenDuration: 1,
      direction: -1,
      frameCount: 1,
    });

    expect(result).toEqual({ kind: "noop", moves: [], deltaFrames: 0 });
  });
});
