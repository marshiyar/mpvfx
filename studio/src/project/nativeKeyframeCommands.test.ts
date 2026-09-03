import { describe, expect, it } from "vitest";

import {
  applyNativeKeyframeCommand,
  type NativeKeyframeCommand,
} from "./nativeKeyframeCommands";
import {
  createNativeParameterTrack,
  type NativeParameterTrack,
} from "./nativeKeyframeTypes";

const rotationTrack = (): NativeParameterTrack<"number"> =>
  createNativeParameterTrack({
    id: "track:rotation",
    parameterId: "transform.rotation",
    valueType: "number",
    frameRate: { numerator: 30_000, denominator: 1_001 },
    keyframes: [
      { id: "a", frame: 0, value: 0, outgoing: { type: "linear" } },
      { id: "b", frame: 30, value: -90, outgoing: { type: "linear" } },
      { id: "c", frame: 60, value: -180, outgoing: { type: "hold" } },
    ],
  });

const expectReversible = <K extends "number" | "vec2" | "rgba">(
  original: NativeParameterTrack<K>,
  command: NativeKeyframeCommand<K>,
): NativeParameterTrack<K> => {
  const applied = applyNativeKeyframeCommand(original, command);
  expect(applied.ok).toBe(true);
  if (!applied.ok) {
    throw new Error(applied.failure.message);
  }
  const reverted = applyNativeKeyframeCommand(applied.track, applied.inverse);
  expect(reverted.ok).toBe(true);
  if (!reverted.ok) {
    throw new Error(reverted.failure.message);
  }
  expect(JSON.stringify(reverted.track)).toBe(JSON.stringify(original));
  return applied.track;
};

describe("native keyframe commands", () => {
  it("inserts at an exact integer project frame and returns a byte-equivalent inverse", () => {
    const original = rotationTrack();
    const next = expectReversible(original, {
      type: "insert",
      keyframe: { id: "inserted", frame: 45, value: -135, outgoing: { type: "linear" } },
    });

    expect(next.keyframes.map(({ id, frame }) => ({ id, frame }))).toEqual([
      { id: "a", frame: 0 },
      { id: "b", frame: 30 },
      { id: "inserted", frame: 45 },
      { id: "c", frame: 60 },
    ]);
    expect(original.keyframes).toHaveLength(3);
  });

  it("upserts at an occupied frame while preserving its stable keyframe ID", () => {
    const original = rotationTrack();
    const next = expectReversible(original, {
      type: "upsert",
      keyframe: {
        id: "proposed-new-id",
        frame: 30,
        value: -45,
        outgoing: { type: "cubic-bezier", controlPoints: { x1: 0.42, y1: 0, x2: 1, y2: 1 } },
      },
    });

    expect(next.keyframes[1]).toEqual({
      id: "b",
      frame: 30,
      value: -45,
      outgoing: { type: "cubic-bezier", controlPoints: { x1: 0.42, y1: 0, x2: 1, y2: 1 } },
    });
  });

  it("upserts at an empty exact frame by inserting the supplied stable ID", () => {
    const next = expectReversible(rotationTrack(), {
      type: "upsert",
      keyframe: { id: "new", frame: 15, value: -30, outgoing: { type: "linear" } },
    });

    expect(next.keyframes.find((keyframe) => keyframe.frame === 15)?.id).toBe("new");
  });

  it("updates a value without changing the keyframe stable ID or other fields", () => {
    const next = expectReversible(rotationTrack(), {
      type: "update-value",
      keyframeId: "b",
      value: -120,
    });

    expect(next.keyframes[1]).toEqual({
      id: "b",
      frame: 30,
      value: -120,
      outgoing: { type: "linear" },
    });
  });

  it("moves one keyframe immutably and restores it with the inverse", () => {
    const original = rotationTrack();
    const next = expectReversible(original, {
      type: "move",
      keyframeId: "b",
      toFrame: 45,
    });

    expect(next.keyframes.find((keyframe) => keyframe.id === "b")?.frame).toBe(45);
    expect(original.keyframes.find((keyframe) => keyframe.id === "b")?.frame).toBe(30);
  });

  it("moves a group atomically while preserving its spacing and deterministic order", () => {
    const next = expectReversible(rotationTrack(), {
      type: "move-group",
      keyframeIds: ["c", "b"],
      deltaFrames: 15,
    });

    expect(next.keyframes.map(({ id, frame }) => ({ id, frame }))).toEqual([
      { id: "a", frame: 0 },
      { id: "b", frame: 45 },
      { id: "c", frame: 75 },
    ]);
  });

  it("deletes one or a group atomically and each result is reversible", () => {
    const oneDeleted = expectReversible(rotationTrack(), {
      type: "delete",
      keyframeId: "b",
    });
    expect(oneDeleted.keyframes.map((keyframe) => keyframe.id)).toEqual(["a", "c"]);

    const groupDeleted = expectReversible(rotationTrack(), {
      type: "delete-group",
      keyframeIds: ["c", "a"],
    });
    expect(groupDeleted.keyframes.map((keyframe) => keyframe.id)).toEqual(["b"]);
  });

  it("sets the interpolation owned by a keyframe's outgoing segment", () => {
    const next = expectReversible(rotationTrack(), {
      type: "set-outgoing",
      keyframeId: "a",
      outgoing: {
        type: "cubic-bezier",
        controlPoints: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
      },
    });

    expect(next.keyframes[0].outgoing).toEqual({
      type: "cubic-bezier",
      controlPoints: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
    });
  });

  it.each([
    { type: "insert", keyframe: { id: "fraction", frame: 1.5, value: 1, outgoing: { type: "linear" } } },
    { type: "move", keyframeId: "b", toFrame: -1 },
    { type: "move-group", keyframeIds: ["b", "c"], deltaFrames: 0.5 },
  ] as const)("rejects invalid command frame time atomically: $type", (command) => {
    const original = rotationTrack();
    const result = applyNativeKeyframeCommand(original, command);

    expect(result.ok).toBe(false);
    expect(result.track).toBe(original);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid-frame");
    }
  });

  it("rejects duplicate insertion IDs and destination frames without mutation", () => {
    const original = rotationTrack();
    const duplicateId = applyNativeKeyframeCommand(original, {
      type: "insert",
      keyframe: { id: "b", frame: 15, value: -10, outgoing: { type: "linear" } },
    });
    const duplicateFrame = applyNativeKeyframeCommand(original, {
      type: "move",
      keyframeId: "a",
      toFrame: 30,
    });

    expect(duplicateId.ok).toBe(false);
    expect(duplicateId.track).toBe(original);
    if (!duplicateId.ok) expect(duplicateId.failure.code).toBe("duplicate-keyframe-id");
    expect(duplicateFrame.ok).toBe(false);
    expect(duplicateFrame.track).toBe(original);
    if (!duplicateFrame.ok) expect(duplicateFrame.failure.code).toBe("frame-collision");
  });

  it("rejects a mixed valid/missing group without partially moving or deleting", () => {
    const original = rotationTrack();
    const moved = applyNativeKeyframeCommand(original, {
      type: "move-group",
      keyframeIds: ["b", "missing"],
      deltaFrames: 10,
    });
    const deleted = applyNativeKeyframeCommand(original, {
      type: "delete-group",
      keyframeIds: ["a", "missing"],
    });

    for (const result of [moved, deleted]) {
      expect(result.ok).toBe(false);
      expect(result.track).toBe(original);
      if (!result.ok) expect(result.failure.code).toBe("missing-keyframe");
    }
    expect(original.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 30, 60]);
  });

  it("rejects an adjacent swap/crossing onto occupied frames with an explicit collision", () => {
    const original = rotationTrack();
    const result = applyNativeKeyframeCommand(original, {
      type: "move-group",
      keyframeIds: ["a", "b"],
      deltaFrames: 30,
    });

    expect(result.ok).toBe(false);
    expect(result.track).toBe(original);
    if (!result.ok) expect(result.failure.code).toBe("frame-collision");
  });

  it("rejects duplicate IDs inside group commands rather than applying them twice", () => {
    const original = rotationTrack();
    const result = applyNativeKeyframeCommand(original, {
      type: "move-group",
      keyframeIds: ["b", "b"],
      deltaFrames: 5,
    });

    expect(result.ok).toBe(false);
    expect(result.track).toBe(original);
    if (!result.ok) expect(result.failure.code).toBe("invalid-group");
  });

  it("rejects a missing keyframe and invalid interpolation with the original track unchanged", () => {
    const original = rotationTrack();
    const missing = applyNativeKeyframeCommand(original, {
      type: "set-outgoing",
      keyframeId: "missing",
      outgoing: { type: "linear" },
    });
    const invalid = applyNativeKeyframeCommand(original, {
      type: "set-outgoing",
      keyframeId: "a",
      outgoing: {
        type: "cubic-bezier",
        controlPoints: { x1: -1, y1: 0, x2: 1, y2: 1 },
      },
    });

    expect(missing.ok).toBe(false);
    expect(missing.track).toBe(original);
    if (!missing.ok) expect(missing.failure.code).toBe("missing-keyframe");
    expect(invalid.ok).toBe(false);
    expect(invalid.track).toBe(original);
    if (!invalid.ok) expect(invalid.failure.code).toBe("invalid-interpolation");
  });
});
