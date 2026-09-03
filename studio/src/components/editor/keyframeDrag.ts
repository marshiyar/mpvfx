/**
 * Pure math for the timeline keyframe-diamond drag-to-retime gesture. Kept free
 * of React/store so the gesture handler stays a thin orchestrator and the
 * click-vs-drag + neighbor clamp are unit-testable in isolation.
 *
 * The diamond is positioned by clip-relative % (same basis it's drawn with), so
 * this layer works entirely in clip-%: it converts the pointer pixel delta to a
 * clip-% drop and clamps it between the dragged keyframe's neighbours (and the
 * clip bounds). The clip-%→tween-% conversion and the move-vs-resize decision
 * happen in the studio handler (it has the tween window + clip timing this layer
 * deliberately doesn't), see `keyframeRetime.ts`.
 */

import {
  STUDIO_OUTPUT_FPS,
  keyframeOutputFrame,
  keyframesShareOutputFrame,
  type KeyframeFrameTiming,
} from "../../hooks/gsapShared";

/** Screen-px the pointer must travel before a press counts as a drag (else click). */
export const KEYFRAME_DRAG_THRESHOLD_PX = 4;
/** Gap (clip-%) kept between a dragged interior keyframe and each neighbour so it
 *  can't equal/cross them when legacy callers have no clip timing. */
const LEGACY_NEIGHBOR_EPSILON_PCT = 0.5;
/** Compatibility only for isolated/duration-less gesture hosts. Studio passes timing. */
const LEGACY_NOOP_EPSILON_PCT = 0.1;
/** Keep JS rounding off the exact half-frame tie used by `Math.round`. */
const FRAME_BOUNDARY_EPSILON_SECONDS = 1e-7;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Clamp a dragged keyframe's clip-% strictly between its immediate neighbours
 * (with a small epsilon so it can't equal/cross them) and to the clip bounds.
 *
 * - Interior keyframe → bounded by both neighbours.
 * - First keyframe (index 0) → left bound is the clip start (0%), so it's free to
 *   travel left toward/past the tween start (a boundary RESIZE the handler owns).
 * - Last keyframe → right bound is the clip end (100%), free to travel right.
 * - Lone keyframe → free across the whole clip [0, 100].
 */
export function clampToNeighbors(
  clipPct: number,
  sortedClipPcts: ReadonlyArray<number>,
  draggedIndex: number,
  timing: KeyframeFrameTiming = {},
): number {
  const draggedPct = sortedClipPcts[draggedIndex] ?? clipPct;
  const duration = timing.duration;
  const hasFrameTiming = typeof duration === "number" && Number.isFinite(duration) && duration > 0;
  let left = 0;
  let right = 100;
  if (draggedIndex > 0) {
    const leftPct = sortedClipPcts[draggedIndex - 1] ?? 0;
    const leftFrame = keyframeOutputFrame(leftPct, timing);
    left =
      hasFrameTiming && leftFrame !== null
        ? (((
            (leftFrame + 0.5) / STUDIO_OUTPUT_FPS +
            FRAME_BOUNDARY_EPSILON_SECONDS -
            (timing.start ?? 0)
          ) /
            duration) *
          100)
        : leftPct + LEGACY_NEIGHBOR_EPSILON_PCT;
  }
  if (draggedIndex < sortedClipPcts.length - 1) {
    const rightPct = sortedClipPcts[draggedIndex + 1] ?? 100;
    const rightFrame = keyframeOutputFrame(rightPct, timing);
    right =
      hasFrameTiming && rightFrame !== null
        ? (((
            (rightFrame - 0.5) / STUDIO_OUTPUT_FPS -
            FRAME_BOUNDARY_EPSILON_SECONDS -
            (timing.start ?? 0)
          ) /
            duration) *
          100)
        : rightPct - LEGACY_NEIGHBOR_EPSILON_PCT;
  }
  // No distinct output frame remains between the neighbours: retain the source
  // frame. Legacy duration-less callers keep their prior midpoint behavior.
  if (left > right) return hasFrameTiming ? draggedPct : (left + right) / 2;
  const clamped = clamp(clipPct, left, right);
  // A sub-frame preview has no distinct rendered destination. Keep the diamond
  // at its authored frame instead of letting it shimmer within that frame.
  return hasFrameTiming && keyframesShareOutputFrame(clamped, draggedPct, timing)
    ? draggedPct
    : clamped;
}

export interface KeyframeDragResult {
  /** `click`: under the drag threshold → seek. `noop`: moved but resolved onto
   *  the original keyframe → skip the commit. `move`: commit the retime. */
  kind: "click" | "noop" | "move";
  /** Clip-relative drop position, neighbour- and clip-clamped (only on `move`). */
  toClipPct?: number;
}

/**
 * Decide whether a diamond press was a click or a drag, and for a drag compute
 * the neighbour-clamped clip-% drop position.
 *
 * - `draggedClipPct`: the dragged diamond's own clip-relative percentage.
 * - `draggedIndex` / `sortedClipPcts`: index of the dragged keyframe within the
 *   clip's keyframes sorted by clip-%, used for the neighbour clamp.
 */
export function resolveKeyframeDrag(opts: {
  pointerDownX: number;
  pointerUpX: number;
  clipWidthPx: number;
  draggedClipPct: number;
  draggedIndex: number;
  sortedClipPcts: ReadonlyArray<number>;
  clipStartTime?: number;
  clipDurationSeconds?: number;
}): KeyframeDragResult {
  const dx = opts.pointerUpX - opts.pointerDownX;
  if (Math.abs(dx) < KEYFRAME_DRAG_THRESHOLD_PX || opts.clipWidthPx <= 0) {
    return { kind: "click" };
  }
  const rawClipPct = opts.draggedClipPct + (dx / opts.clipWidthPx) * 100;
  const timing = { start: opts.clipStartTime, duration: opts.clipDurationSeconds };
  const toClipPct = clampToNeighbors(
    rawClipPct,
    opts.sortedClipPcts,
    opts.draggedIndex,
    timing,
  );
  const hasFrameTiming =
    typeof opts.clipDurationSeconds === "number" &&
    Number.isFinite(opts.clipDurationSeconds) &&
    opts.clipDurationSeconds > 0;
  if (
    hasFrameTiming
      ? keyframesShareOutputFrame(toClipPct, opts.draggedClipPct, timing)
      : Math.abs(toClipPct - opts.draggedClipPct) < LEGACY_NOOP_EPSILON_PCT
  ) {
    return { kind: "noop" };
  }
  return { kind: "move", toClipPct };
}

/**
 * Live drag preview: the dragged diamond's clip-% as it follows the pointer,
 * neighbour- and clip-clamped to match where the commit will land. Visual only —
 * no runtime/GSAP hold (the #1763 flake).
 */
export function previewClipPct(opts: {
  pointerDownX: number;
  pointerMoveX: number;
  clipWidthPx: number;
  draggedClipPct: number;
  draggedIndex: number;
  sortedClipPcts: ReadonlyArray<number>;
  clipStartTime?: number;
  clipDurationSeconds?: number;
}): number {
  if (opts.clipWidthPx <= 0) return opts.draggedClipPct;
  const dx = opts.pointerMoveX - opts.pointerDownX;
  return clampToNeighbors(
    opts.draggedClipPct + (dx / opts.clipWidthPx) * 100,
    opts.sortedClipPcts,
    opts.draggedIndex,
    { start: opts.clipStartTime, duration: opts.clipDurationSeconds },
  );
}
