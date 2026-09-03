import type {
  CubicBezierControlPoints,
  NativeInterpolation,
  NativeParameterTrack,
  NativeParameterValueMap,
  NativeValueType,
  RgbaValue,
  Vec2Value,
} from "./nativeKeyframeTypes";

const cloneValue = <K extends NativeValueType>(
  valueType: K,
  value: NativeParameterValueMap[K],
): NativeParameterValueMap[K] => {
  if (valueType === "number") {
    return value;
  }
  return { ...(value as Vec2Value | RgbaValue) } as NativeParameterValueMap[K];
};

const cubicCoordinate = (time: number, first: number, second: number): number => {
  const inverse = 1 - time;
  return (
    3 * inverse * inverse * time * first +
    3 * inverse * time * time * second +
    time * time * time
  );
};

const cubicDerivative = (time: number, first: number, second: number): number => {
  const inverse = 1 - time;
  return (
    3 * inverse * inverse * first +
    6 * inverse * time * (second - first) +
    3 * time * time * (1 - second)
  );
};

/** Resolve cubic-bezier timing by x, then return its y value. */
const evaluateCubicBezier = (
  progress: number,
  { x1, y1, x2, y2 }: CubicBezierControlPoints,
): number => {
  if (progress === 0 || progress === 1) {
    return progress;
  }

  let parameter = progress;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const difference = cubicCoordinate(parameter, x1, x2) - progress;
    if (Math.abs(difference) < 1e-9) {
      return cubicCoordinate(parameter, y1, y2);
    }
    const derivative = cubicDerivative(parameter, x1, x2);
    if (Math.abs(derivative) < 1e-7) {
      break;
    }
    const candidate = parameter - difference / derivative;
    if (candidate < 0 || candidate > 1) {
      break;
    }
    parameter = candidate;
  }

  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 30; iteration += 1) {
    parameter = (lower + upper) / 2;
    const x = cubicCoordinate(parameter, x1, x2);
    if (x < progress) {
      lower = parameter;
    } else {
      upper = parameter;
    }
  }
  return cubicCoordinate(parameter, y1, y2);
};

const applyInterpolation = (progress: number, interpolation: NativeInterpolation): number => {
  if (interpolation.type === "hold") {
    return 0;
  }
  if (interpolation.type === "linear") {
    return progress;
  }
  return evaluateCubicBezier(progress, interpolation.controlPoints);
};

const mix = (start: number, end: number, progress: number): number =>
  start + (end - start) * progress;

const interpolateValue = <K extends NativeValueType>(
  valueType: K,
  start: NativeParameterValueMap[K],
  end: NativeParameterValueMap[K],
  progress: number,
): NativeParameterValueMap[K] => {
  if (valueType === "number") {
    return mix(start as number, end as number, progress) as NativeParameterValueMap[K];
  }
  if (valueType === "vec2") {
    const first = start as Vec2Value;
    const last = end as Vec2Value;
    return {
      x: mix(first.x, last.x, progress),
      y: mix(first.y, last.y, progress),
    } as NativeParameterValueMap[K];
  }

  const first = start as RgbaValue;
  const last = end as RgbaValue;
  return {
    red: mix(first.red, last.red, progress),
    green: mix(first.green, last.green, progress),
    blue: mix(first.blue, last.blue, progress),
    alpha: mix(first.alpha, last.alpha, progress),
  } as NativeParameterValueMap[K];
};

/**
 * Pure frame evaluator shared by interactive preview and frame-by-frame export.
 * Project-frame time is deliberately integral so both callers address the same sample.
 */
export const evaluateNativeParameterTrack = <K extends NativeValueType>(
  track: NativeParameterTrack<K>,
  projectFrame: number,
): NativeParameterValueMap[K] => {
  if (!Number.isInteger(projectFrame)) {
    throw new TypeError("Native keyframes must be evaluated at an integer project frame");
  }
  if (track.keyframes.length === 0) {
    throw new TypeError(`Native parameter track ${track.id} has no keyframes`);
  }

  const first = track.keyframes[0];
  const last = track.keyframes[track.keyframes.length - 1];
  if (projectFrame <= first.frame) {
    return cloneValue(track.valueType, first.value);
  }
  if (projectFrame >= last.frame) {
    return cloneValue(track.valueType, last.value);
  }

  let lowerIndex = 0;
  let upperIndex = track.keyframes.length - 1;
  while (lowerIndex + 1 < upperIndex) {
    const middleIndex = Math.floor((lowerIndex + upperIndex) / 2);
    if (track.keyframes[middleIndex].frame <= projectFrame) {
      lowerIndex = middleIndex;
    } else {
      upperIndex = middleIndex;
    }
  }

  const start = track.keyframes[lowerIndex];
  const end = track.keyframes[upperIndex];
  if (projectFrame === start.frame) {
    return cloneValue(track.valueType, start.value);
  }
  if (projectFrame === end.frame) {
    return cloneValue(track.valueType, end.value);
  }

  const linearProgress = (projectFrame - start.frame) / (end.frame - start.frame);
  const interpolatedProgress = applyInterpolation(linearProgress, start.outgoing);
  return interpolateValue(track.valueType, start.value, end.value, interpolatedProgress);
};
