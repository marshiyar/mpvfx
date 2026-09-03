import { describe, expect, it } from "vitest";
import {
  resolveKeyframeDrag,
  previewClipPct,
  clampToNeighbors,
  KEYFRAME_DRAG_THRESHOLD_PX,
} from "./keyframeDrag";

// Three keyframes at clip-% 20 / 40 / 60. The dragged one (index 1) is bounded
// by its neighbours at 20 and 60; first/last are bounded only by the clip.
const CLIP_PCTS = [20, 40, 60];

describe("resolveKeyframeDrag — click vs drag threshold", () => {
  const base = {
    clipWidthPx: 200,
    draggedClipPct: 40,
    draggedIndex: 1,
    sortedClipPcts: CLIP_PCTS,
  };

  it("treats sub-threshold movement as a click", () => {
    const r = resolveKeyframeDrag({
      ...base,
      pointerDownX: 100,
      pointerUpX: 100 + (KEYFRAME_DRAG_THRESHOLD_PX - 1),
    });
    expect(r.kind).toBe("click");
  });

  it("treats movement at/over the threshold as a drag", () => {
    const r = resolveKeyframeDrag({
      ...base,
      pointerDownX: 100,
      pointerUpX: 100 + KEYFRAME_DRAG_THRESHOLD_PX + 1,
    });
    expect(r.kind).toBe("move");
  });

  it("guards a zero-width clip (no division blowup) → click", () => {
    const r = resolveKeyframeDrag({ ...base, clipWidthPx: 0, pointerDownX: 0, pointerUpX: 50 });
    expect(r.kind).toBe("click");
  });

  it("no-ops a past-threshold drag that resolves to the source percentage", () => {
    // Over the px threshold, but on a huge clip the 5px maps to ~0.00125 clip%
    // away — under the noop epsilon, so don't commit a churn write.
    const r = resolveKeyframeDrag({
      ...base,
      clipWidthPx: 1_000_000,
      pointerDownX: 80,
      pointerUpX: 80 + KEYFRAME_DRAG_THRESHOLD_PX + 1,
      clipStartTime: 0,
      clipDurationSeconds: 120,
    });
    expect(r.kind).toBe("noop");
  });

  it("does not discard an adjacent-frame move on a 120s clip", () => {
    // Five pixels crosses the physical drag threshold and represents 1.5 output
    // frames here. The legacy 0.1%-epsilon called this a no-op (~12 frames).
    const r = resolveKeyframeDrag({
      ...base,
      clipWidthPx: 12_000,
      pointerDownX: 6_000,
      pointerUpX: 6_005,
      clipStartTime: 0,
      clipDurationSeconds: 120,
    });
    expect(r.kind).toBe("move");
    expect(r.toClipPct).toBeCloseTo(40.041667, 5);
  });
});

describe("resolveKeyframeDrag — pixel delta → clip%", () => {
  // 200px wide clip → 2px per clip-%. Dragged diamond at clip 40%, pointer-down
  // anchored at its pixel position (80px) for a clean delta.
  const base = {
    clipWidthPx: 200,
    draggedClipPct: 40,
    draggedIndex: 1,
    sortedClipPcts: CLIP_PCTS,
    pointerDownX: 80,
  };

  it("maps a rightward drag to clip-%", () => {
    // +20px → +10 clip% → clip 50% (within [20, 60]).
    const r = resolveKeyframeDrag({ ...base, pointerUpX: 100 });
    expect(r.kind).toBe("move");
    expect(r.toClipPct).toBeCloseTo(50, 5);
  });

  it("maps a leftward drag", () => {
    // -20px → -10 clip% → clip 30%.
    const r = resolveKeyframeDrag({ ...base, pointerUpX: 60 });
    expect(r.toClipPct).toBeCloseTo(30, 5);
  });
});

describe("resolveKeyframeDrag — neighbour + clip clamp", () => {
  const base = { clipWidthPx: 200, pointerDownX: 80 };

  it("an interior keyframe cannot pass its right neighbour", () => {
    // Drag the middle (clip 40, index 1) far right → clamps just inside 60.
    const r = resolveKeyframeDrag({
      ...base,
      draggedClipPct: 40,
      draggedIndex: 1,
      sortedClipPcts: CLIP_PCTS,
      pointerUpX: 5000,
    });
    expect(r.toClipPct).toBeLessThan(60);
    expect(r.toClipPct).toBeGreaterThan(59); // epsilon inside, not equal/crossed
  });

  it("an interior keyframe cannot pass its left neighbour", () => {
    const r = resolveKeyframeDrag({
      ...base,
      draggedClipPct: 40,
      draggedIndex: 1,
      sortedClipPcts: CLIP_PCTS,
      pointerUpX: -5000,
    });
    expect(r.toClipPct).toBeGreaterThan(20);
    expect(r.toClipPct).toBeLessThan(21);
  });

  it("the first keyframe is free to the clip start (0%) but bounded by the 2nd", () => {
    // Index 0 dragged left past 0 → clamps to 0.
    const left = resolveKeyframeDrag({
      ...base,
      draggedClipPct: 20,
      draggedIndex: 0,
      sortedClipPcts: CLIP_PCTS,
      pointerUpX: -5000,
    });
    expect(left.toClipPct).toBe(0);
    // Dragged right past the 2nd keyframe (40) → clamps just inside it.
    const right = resolveKeyframeDrag({
      ...base,
      draggedClipPct: 20,
      draggedIndex: 0,
      sortedClipPcts: CLIP_PCTS,
      pointerUpX: 5000,
    });
    expect(right.toClipPct).toBeLessThan(40);
    expect(right.toClipPct).toBeGreaterThan(39);
  });

  it("the last keyframe is free to the clip end (100%) but bounded by the 2nd-to-last", () => {
    const right = resolveKeyframeDrag({
      ...base,
      draggedClipPct: 60,
      draggedIndex: 2,
      sortedClipPcts: CLIP_PCTS,
      pointerUpX: 5000,
    });
    expect(right.toClipPct).toBe(100);
    const left = resolveKeyframeDrag({
      ...base,
      draggedClipPct: 60,
      draggedIndex: 2,
      sortedClipPcts: CLIP_PCTS,
      pointerUpX: -5000,
    });
    expect(left.toClipPct).toBeGreaterThan(40);
    expect(left.toClipPct).toBeLessThan(41);
  });

  it("a lone keyframe moves freely across the whole clip", () => {
    const r = resolveKeyframeDrag({
      ...base,
      draggedClipPct: 50,
      draggedIndex: 0,
      sortedClipPcts: [50],
      pointerUpX: 5000,
    });
    expect(r.toClipPct).toBe(100);
  });
});

describe("clampToNeighbors", () => {
  it("pins to the midpoint when neighbours are tighter than 2·epsilon", () => {
    // Neighbours at 10 and 10.5 → window [10.5, 10] inverts → midpoint 10.25.
    expect(clampToNeighbors(50, [10, 10.2, 10.5], 1)).toBeCloseTo(10.25, 5);
  });

  it("allows dense adjacent-frame keys on a 120s clip without a 0.5% gap", () => {
    // At 120s/30fps, 0.027778% is one frame. The old 0.5% clamp was ~18
    // frames and pushed this key backward instead of leaving it between its
    // neighbours. The frame-aware boundary keeps it on frame 1800.
    expect(
      clampToNeighbors(100, [49, 50, 50.027778], 1, {
        start: 0,
        duration: 120,
      }),
    ).toBeCloseTo(50, 5);
  });
});

describe("previewClipPct", () => {
  it("follows the pointer in clip-% and clamps to neighbours", () => {
    expect(
      previewClipPct({
        pointerDownX: 80,
        pointerMoveX: 100,
        clipWidthPx: 200,
        draggedClipPct: 40,
        draggedIndex: 1,
        sortedClipPcts: CLIP_PCTS,
      }),
    ).toBeCloseTo(50, 5);
    // Far right → clamps just inside the right neighbour (60), not the clip edge.
    expect(
      previewClipPct({
        pointerDownX: 80,
        pointerMoveX: 5000,
        clipWidthPx: 200,
        draggedClipPct: 40,
        draggedIndex: 1,
        sortedClipPcts: CLIP_PCTS,
      }),
    ).toBeLessThan(60);
  });
});
