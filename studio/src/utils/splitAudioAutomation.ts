import {
  HF_AUDIO_AUTOMATION_ATTR,
  MAX_AUTOMATION_POINTS,
  parseAutomation,
  sampleAutomationLane,
  serializeAutomation,
  shapeProgress,
  type HfAutomation,
  type HfAutomationLane,
  type HfAutomationPoint,
} from "@hyperframes/core/audio-automation";
import {
  applyPatchByTarget,
  readAttributeByTarget,
  type PatchTarget,
} from "./sourcePatcher";

const shapeFrom = (point: HfAutomationPoint | undefined) => ({
  ...(point?.curve === undefined ? {} : { curve: point.curve }),
  ...(point?.viaX === undefined || point.viaY === undefined
    ? {}
    : { viaX: point.viaX, viaY: point.viaY }),
});

/**
 * A cropped exponent/via segment is generally not closed under the compact
 * HfAutomationPoint shape model. Approximate only the cut segment, adaptively,
 * and refuse the operation if the serialized format's point budget cannot
 * honour this error bound. This keeps the failure explicit instead of saving a
 * lane that merely happens to meet at the razor and audibly changes afterward.
 */
const SPLIT_FIT_TOLERANCE = 2e-9;
const FIT_SAMPLE_COUNT = 32;

type PointShape = Pick<HfAutomationPoint, "curve" | "viaX" | "viaY">;
type FittedSegment = {
  from: number;
  to: number;
  point: HfAutomationPoint;
  error: number;
};

function hasNonlinearShape(point: HfAutomationPoint): boolean {
  return Boolean(point.curve)
    || (point.viaX !== undefined && point.viaY !== undefined);
}

function candidateError(
  normalizedValue: (progress: number) => number,
  shape: PointShape,
): number {
  let error = 0;
  for (let index = 1; index < FIT_SAMPLE_COUNT; index += 1) {
    const progress = index / FIT_SAMPLE_COUNT;
    error = Math.max(
      error,
      Math.abs(shapeProgress(progress, shape) - normalizedValue(progress)),
    );
  }
  return error;
}

function fittedShape(
  lane: Readonly<HfAutomationLane>,
  from: number,
  to: number,
): { shape: PointShape; error: number } {
  const fromValue = sampleAutomationLane(lane, from);
  const toValue = sampleAutomationLane(lane, to);
  const span = toValue - fromValue;
  if (Math.abs(span) < 1e-15) return { shape: {}, error: 0 };

  const normalizedValue = (progress: number) => (
    (sampleAutomationLane(lane, from + (to - from) * progress) - fromValue) / span
  );
  let best: { shape: PointShape; error: number } = {
    shape: {},
    error: candidateError(normalizedValue, {}),
  };

  // The legacy exponent has one useful degree of freedom. Matching the centre
  // exactly is a good deterministic candidate for gently curved restrictions.
  const midpoint = normalizedValue(0.5);
  if (midpoint > 0 && midpoint < 1) {
    const exponent = Math.log(midpoint) / Math.log(0.5);
    const curve = Math.log2(exponent) / 2;
    if (Number.isFinite(curve) && curve >= -1 && curve <= 1) {
      const shape = Math.abs(curve) < 1e-12 ? {} : { curve };
      const error = candidateError(normalizedValue, shape);
      if (error < best.error) best = { shape, error };
    }
  }

  // A via point supplies a more flexible conic candidate. Search its horizontal
  // position deterministically; its vertical coordinate is sampled from the
  // original curve, so every candidate passes through a real source value.
  let bestViaX = 0.5;
  let bestViaError = Number.POSITIVE_INFINITY;
  const scoreVia = (viaX: number) => {
    const viaY = normalizedValue(viaX);
    if (!(viaY > 0 && viaY < 1) || Math.abs(viaX - viaY) < 1e-6) {
      return Number.POSITIVE_INFINITY;
    }
    return candidateError(normalizedValue, { viaX, viaY });
  };
  for (let index = 1; index < 100; index += 1) {
    const viaX = 0.001 + (0.998 * index) / 100;
    const error = scoreVia(viaX);
    if (error < bestViaError) {
      bestViaError = error;
      bestViaX = viaX;
    }
  }
  for (let step = 0.01; step > 1e-8; step *= 0.25) {
    for (const viaX of [
      bestViaX - step,
      bestViaX - step / 2,
      bestViaX + step / 2,
      bestViaX + step,
    ]) {
      if (viaX <= 0.001 || viaX >= 0.999) continue;
      const error = scoreVia(viaX);
      if (error < bestViaError) {
        bestViaError = error;
        bestViaX = viaX;
      }
    }
  }
  if (bestViaError < best.error) {
    best = {
      shape: { viaX: bestViaX, viaY: normalizedValue(bestViaX) },
      error: bestViaError,
    };
  }
  return { shape: best.shape, error: best.error * Math.abs(span) };
}

function fitSegment(
  lane: Readonly<HfAutomationLane>,
  from: number,
  to: number,
  outputOffset: number,
): FittedSegment {
  const { shape, error } = fittedShape(lane, from, to);
  return {
    from,
    to,
    point: {
      t: from - outputOffset,
      v: sampleAutomationLane(lane, from),
      ...shape,
    },
    error,
  };
}

function fittedRestriction(
  lane: Readonly<HfAutomationLane>,
  from: number,
  to: number,
  outputOffset: number,
  maxPoints: number,
  retainedCurve?: number,
): HfAutomationPoint[] {
  if (maxPoints < 2) {
    throw new Error("Audio automation cannot be split within the 512-point lane limit");
  }
  const segments = [fitSegment(lane, from, to, outputOffset)];
  while (true) {
    let worstIndex = -1;
    let worstError = SPLIT_FIT_TOLERANCE;
    for (let index = 0; index < segments.length; index += 1) {
      const error = segments[index]!.error;
      if (error > worstError) {
        worstError = error;
        worstIndex = index;
      }
    }
    if (worstIndex < 0) break;
    if (segments.length + 1 >= maxPoints) {
      throw new Error(
        "Audio automation curve cannot be preserved within the 512-point lane limit",
      );
    }
    const worst = segments[worstIndex]!;
    const middle = worst.from + (worst.to - worst.from) / 2;
    segments.splice(
      worstIndex,
      1,
      fitSegment(lane, worst.from, middle, outputOffset),
      fitSegment(lane, middle, worst.to, outputOffset),
    );
  }

  const points = segments.map((segment) => segment.point);
  if (retainedCurve !== undefined && points[0]) {
    // Via controls win in the evaluator, so retaining the authored legacy
    // curve remains byte-semantic metadata without changing the fitted shape.
    points[0] = { ...points[0], curve: retainedCurve };
  }
  points.push({ t: to - outputOffset, v: sampleAutomationLane(lane, to) });
  return points;
}

function splitLane(
  lane: Readonly<HfAutomationLane>,
  splitLocalSeconds: number,
): { left: HfAutomationLane; right: HfAutomationLane } {
  const exact = lane.points.find((point) => point.t === splitLocalSeconds);
  const before = lane.points.filter((point) => point.t < splitLocalSeconds);
  const after = lane.points.filter((point) => point.t > splitLocalSeconds);
  const previous = before.at(-1);
  const next = after[0];
  const boundaryValue = sampleAutomationLane(lane, splitLocalSeconds);

  const leftPoints: HfAutomationPoint[] = [...before];
  if (exact) {
    leftPoints.push(exact);
  } else if (previous && next) {
    if (previous.viaX !== undefined && previous.viaY !== undefined) {
      const retained = leftPoints.slice(0, -1);
      leftPoints.splice(
        0,
        leftPoints.length,
        ...retained,
        ...fittedRestriction(
          lane,
          previous.t,
          splitLocalSeconds,
          0,
          MAX_AUTOMATION_POINTS - retained.length,
          previous.curve,
        ),
      );
    } else {
      // Prefixes of exponent curves remain the same exponent after their value
      // and duration are normalised, so this compact form is exact.
      leftPoints.push({ t: splitLocalSeconds, v: boundaryValue });
    }
  } else if (!previous && next) {
    // Before its first point a lane holds that point's value. One point at the
    // new clip origin preserves the whole left half without manufacturing a
    // redundant endpoint (or exceeding MAX_AUTOMATION_POINTS).
    leftPoints.push({ t: 0, v: boundaryValue });
  }

  const rightPoints: HfAutomationPoint[] = [];
  if (exact) {
    rightPoints.push({ ...exact, t: 0 });
  } else if (previous) {
    if (next && hasNonlinearShape(previous)) {
      const retainedAfter = after.slice(1);
      rightPoints.push(...fittedRestriction(
        lane,
        splitLocalSeconds,
        next.t,
        splitLocalSeconds,
        MAX_AUTOMATION_POINTS - retainedAfter.length,
        previous.curve,
      ));
      rightPoints.push(...retainedAfter.map((point) => ({
        ...point,
        t: point.t - splitLocalSeconds,
      })));
      return {
        left: { target: lane.target, points: leftPoints },
        right: { target: lane.target, points: rightPoints },
      };
    }
    rightPoints.push({ t: 0, v: boundaryValue, ...shapeFrom(previous) });
  }
  rightPoints.push(...after.map((point) => ({ ...point, t: point.t - splitLocalSeconds })));

  return {
    left: { target: lane.target, points: leftPoints },
    right: { target: lane.target, points: rightPoints },
  };
}

export function splitAudioAutomation(
  automation: Readonly<HfAutomation>,
  splitLocalSeconds: number,
): { left: HfAutomation; right: HfAutomation } {
  if (!Number.isFinite(splitLocalSeconds) || splitLocalSeconds <= 0) {
    throw new Error("Audio automation split time must be a positive clip-local second");
  }
  const lanes = automation.lanes.map((lane) => splitLane(lane, splitLocalSeconds));
  return {
    left: { version: automation.version, lanes: lanes.map(({ left }) => left) },
    right: { version: automation.version, lanes: lanes.map(({ right }) => right) },
  };
}

/**
 * Crop the cloned compatibility attributes produced by splitElementInHtml.
 * Parsing happens before either patch, so unreadable automation rejects the
 * surrounding native file transaction instead of saving two corrupted lanes.
 */
export function splitAudioAutomationInHtml(
  html: string,
  leftTarget: PatchTarget,
  rightTarget: PatchTarget,
  splitLocalSeconds: number,
): string {
  const raw = readAttributeByTarget(html, leftTarget, HF_AUDIO_AUTOMATION_ATTR);
  if (raw === undefined) return html;

  const split = splitAudioAutomation(parseAutomation(raw), splitLocalSeconds);
  let patched = applyPatchByTarget(html, leftTarget, {
    type: "attribute",
    property: HF_AUDIO_AUTOMATION_ATTR,
    value: serializeAutomation(split.left),
  });
  patched = applyPatchByTarget(patched, rightTarget, {
    type: "attribute",
    property: HF_AUDIO_AUTOMATION_ATTR,
    value: serializeAutomation(split.right),
  });
  return patched;
}
