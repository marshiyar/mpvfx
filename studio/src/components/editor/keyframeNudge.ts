import {
  STUDIO_OUTPUT_FPS,
  keyframeOutputFrame,
  studioOutputFrame,
} from "../../hooks/gsapShared";

const KEYFRAME_PERCENTAGE_SCALE = 1e10;

function canonicalPercentage(value: number): number {
  return Math.max(
    0,
    Math.min(100, Math.round(value * KEYFRAME_PERCENTAGE_SCALE) / KEYFRAME_PERCENTAGE_SCALE),
  );
}

export interface KeyframeNudgeMove {
  from: number;
  to: number;
}

export interface KeyframeNudgePlan {
  kind: "noop" | "move";
  moves: KeyframeNudgeMove[];
  /** Signed rendered-frame delta shared by every selected keyframe. */
  deltaFrames: number;
}

const NO_NUDGE: KeyframeNudgePlan = { kind: "noop", moves: [], deltaFrames: 0 };

/**
 * Plan a frame-quantized, same-tween group nudge.
 *
 * Every selected key receives one shared integer frame delta, so its relative
 * timing is preserved. The group stops at tween bounds or immediately before
 * an unselected neighbor; it never crosses or merges authored keyframes.
 * Ambiguous legacy source rows that already share one output frame fail safe.
 */
export function planKeyframeNudge(options: {
  keyframePercentages: readonly number[];
  selectedPercentages: readonly number[];
  tweenStart: number;
  tweenDuration: number;
  direction: -1 | 1;
  frameCount: number;
}): KeyframeNudgePlan {
  const {
    keyframePercentages,
    selectedPercentages,
    tweenStart,
    tweenDuration,
    direction,
  } = options;
  const requestedFrames = Math.max(0, Math.trunc(options.frameCount));
  if (
    requestedFrames === 0 ||
    selectedPercentages.length === 0 ||
    !Number.isFinite(tweenStart) ||
    !Number.isFinite(tweenDuration) ||
    tweenDuration <= 0
  ) {
    return NO_NUDGE;
  }

  const timing = { start: tweenStart, duration: tweenDuration };
  const rows = keyframePercentages.map((percentage) => ({
    percentage,
    frame: keyframeOutputFrame(percentage, timing),
    selected: selectedPercentages.includes(percentage),
  }));
  if (rows.some(({ frame }) => frame === null)) return NO_NUDGE;

  const occupiedFrames = new Set<number>();
  for (const row of rows) {
    const frame = row.frame as number;
    // Two source keys on one rendered frame cannot be moved predictably from a
    // collapsed diamond. Require an explicit cleanup instead of choosing one.
    if (occupiedFrames.has(frame)) return NO_NUDGE;
    occupiedFrames.add(frame);
  }

  const selected = rows.filter((row) => row.selected) as Array<{
    percentage: number;
    frame: number;
    selected: true;
  }>;
  if (selected.length !== new Set(selectedPercentages).size) return NO_NUDGE;
  const unselectedFrames = rows
    .filter((row) => !row.selected)
    .map((row) => row.frame as number);
  const startFrame = studioOutputFrame(tweenStart);
  const endFrame = studioOutputFrame(tweenStart + tweenDuration);
  if (startFrame === null || endFrame === null) return NO_NUDGE;

  let allowedFrames = requestedFrames;
  if (direction > 0) {
    allowedFrames = Math.min(
      allowedFrames,
      ...selected.map(({ frame }) => endFrame - frame),
      ...selected.flatMap(({ frame }) =>
        unselectedFrames.filter((other) => other > frame).map((other) => other - frame - 1),
      ),
    );
  } else {
    allowedFrames = Math.min(
      allowedFrames,
      ...selected.map(({ frame }) => frame - startFrame),
      ...selected.flatMap(({ frame }) =>
        unselectedFrames.filter((other) => other < frame).map((other) => frame - other - 1),
      ),
    );
  }
  allowedFrames = Math.max(0, Math.trunc(allowedFrames));
  if (allowedFrames === 0) return NO_NUDGE;

  const deltaFrames = direction * allowedFrames;
  const percentageDelta = (deltaFrames / STUDIO_OUTPUT_FPS / tweenDuration) * 100;
  const moves = selected.map(({ percentage }) => ({
    from: percentage,
    to: canonicalPercentage(percentage + percentageDelta),
  }));
  return { kind: "move", moves, deltaFrames };
}
