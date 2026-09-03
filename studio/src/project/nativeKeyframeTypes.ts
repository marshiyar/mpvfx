export const NATIVE_KEYFRAME_SCHEMA_VERSION = 1 as const;

export interface RationalFrameRate {
  readonly numerator: number;
  readonly denominator: number;
}

export interface Vec2Value {
  readonly x: number;
  readonly y: number;
}

export interface RgbaValue {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

export interface NativeParameterValueMap {
  number: number;
  vec2: Vec2Value;
  rgba: RgbaValue;
}

export type NativeValueType = keyof NativeParameterValueMap;
export type NativeParameterValue = NativeParameterValueMap[NativeValueType];

export interface CubicBezierControlPoints {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export type NativeInterpolation =
  | { readonly type: "hold" }
  | { readonly type: "linear" }
  | {
      readonly type: "cubic-bezier";
      readonly controlPoints: CubicBezierControlPoints;
    };

export interface NativeKeyframe<T extends NativeParameterValue = NativeParameterValue> {
  readonly id: string;
  readonly frame: number;
  readonly value: T;
  /** Controls the segment that starts at this keyframe. */
  readonly outgoing: NativeInterpolation;
}

export interface NativeParameterTrack<K extends NativeValueType = NativeValueType> {
  readonly schemaVersion: typeof NATIVE_KEYFRAME_SCHEMA_VERSION;
  readonly id: string;
  readonly parameterId: string;
  readonly valueType: K;
  readonly frameRate: RationalFrameRate;
  readonly keyframes: readonly NativeKeyframe<NativeParameterValueMap[K]>[];
}

export interface NativeParameterTrackInput<K extends NativeValueType> {
  readonly id: string;
  readonly parameterId: string;
  readonly valueType: K;
  readonly frameRate: RationalFrameRate;
  readonly keyframes: readonly NativeKeyframe<NativeParameterValueMap[K]>[];
}

export type NativeKeyframeValidationCode =
  | "invalid-frame-rate"
  | "invalid-track-id"
  | "invalid-parameter-id"
  | "empty-track"
  | "invalid-keyframe-id"
  | "duplicate-keyframe-id"
  | "duplicate-keyframe-frame"
  | "invalid-keyframe-frame"
  | "invalid-value"
  | "invalid-interpolation";

export class NativeKeyframeValidationError extends Error {
  readonly code: NativeKeyframeValidationCode;

  constructor(code: NativeKeyframeValidationCode, message: string) {
    super(message);
    this.name = "NativeKeyframeValidationError";
    this.code = code;
  }
}

const throwValidation = (code: NativeKeyframeValidationCode, message: string): never => {
  throw new NativeKeyframeValidationError(code, message);
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const validateRationalFrameRate = (
  frameRate: RationalFrameRate,
): RationalFrameRate => {
  if (!Number.isInteger(frameRate.numerator)) {
    return throwValidation("invalid-frame-rate", "Frame-rate numerator must be an integer");
  }
  if (!Number.isInteger(frameRate.denominator)) {
    return throwValidation("invalid-frame-rate", "Frame-rate denominator must be an integer");
  }
  if (frameRate.numerator <= 0) {
    return throwValidation("invalid-frame-rate", "Frame-rate numerator must be greater than zero");
  }
  if (frameRate.denominator <= 0) {
    return throwValidation("invalid-frame-rate", "Frame-rate denominator must be greater than zero");
  }
  return { numerator: frameRate.numerator, denominator: frameRate.denominator };
};

const validateStableId = (
  id: string,
  kind: "track" | "parameter" | "keyframe",
): void => {
  if (typeof id !== "string" || id.trim().length === 0) {
    const code =
      kind === "track"
        ? "invalid-track-id"
        : kind === "parameter"
          ? "invalid-parameter-id"
          : "invalid-keyframe-id";
    throwValidation(code, `${kind[0].toUpperCase()}${kind.slice(1)} ID must not be empty`);
  }
};

const validateValue = <K extends NativeValueType>(
  valueType: K,
  value: NativeParameterValueMap[K],
  keyframeId: string,
): void => {
  if (valueType === "number") {
    if (!isFiniteNumber(value)) {
      throwValidation("invalid-value", `Keyframe ${keyframeId} value must be finite`);
    }
    return;
  }

  if (valueType === "vec2") {
    const vector = value as Vec2Value;
    if (!vector || !isFiniteNumber(vector.x) || !isFiniteNumber(vector.y)) {
      throwValidation("invalid-value", `Keyframe ${keyframeId} vec2 components must be finite`);
    }
    return;
  }

  const color = value as RgbaValue;
  const channels = ["red", "green", "blue", "alpha"] as const;
  for (const channel of channels) {
    if (!color || !isFiniteNumber(color[channel])) {
      throwValidation("invalid-value", `Keyframe ${keyframeId} ${channel} must be finite`);
    }
    if (color[channel] < 0 || color[channel] > 1) {
      throwValidation("invalid-value", `Keyframe ${keyframeId} ${channel} must be between 0 and 1`);
    }
  }
};

const validateInterpolation = (interpolation: NativeInterpolation, keyframeId: string): void => {
  if (interpolation.type === "hold" || interpolation.type === "linear") {
    return;
  }
  if (interpolation.type !== "cubic-bezier" || !interpolation.controlPoints) {
    throwValidation("invalid-interpolation", `Keyframe ${keyframeId} has an invalid interpolation`);
  }

  const { x1, y1, x2, y2 } = interpolation.controlPoints;
  for (const [name, value] of Object.entries({ x1, y1, x2, y2 })) {
    if (!isFiniteNumber(value)) {
      throwValidation(
        "invalid-interpolation",
        `Keyframe ${keyframeId} cubic-bezier ${name} must be finite`,
      );
    }
  }
  if (x1 < 0 || x1 > 1) {
    throwValidation(
      "invalid-interpolation",
      `Keyframe ${keyframeId} cubic-bezier x1 must be between 0 and 1`,
    );
  }
  if (x2 < 0 || x2 > 1) {
    throwValidation(
      "invalid-interpolation",
      `Keyframe ${keyframeId} cubic-bezier x2 must be between 0 and 1`,
    );
  }
};

export const createNativeParameterTrack = <K extends NativeValueType>(
  input: NativeParameterTrackInput<K>,
): NativeParameterTrack<K> => {
  validateStableId(input.id, "track");
  validateStableId(input.parameterId, "parameter");
  const frameRate = validateRationalFrameRate(input.frameRate);
  if (input.keyframes.length === 0) {
    throwValidation("empty-track", `Parameter track ${input.id} must contain at least one keyframe`);
  }

  const keyframeIds = new Set<string>();
  const keyframeFrames = new Set<number>();
  const keyframes = input.keyframes.map((keyframe) => {
    validateStableId(keyframe.id, "keyframe");
    if (keyframeIds.has(keyframe.id)) {
      throwValidation(
        "duplicate-keyframe-id",
        `Parameter track ${input.id} has duplicate keyframe ID ${keyframe.id}`,
      );
    }
    keyframeIds.add(keyframe.id);

    if (!Number.isInteger(keyframe.frame)) {
      throwValidation(
        "invalid-keyframe-frame",
        `Keyframe ${keyframe.id} must use an integer project frame`,
      );
    }
    if (keyframe.frame < 0) {
      throwValidation(
        "invalid-keyframe-frame",
        `Keyframe ${keyframe.id} project frame must not be negative`,
      );
    }
    if (keyframeFrames.has(keyframe.frame)) {
      throwValidation(
        "duplicate-keyframe-frame",
        `Parameter track ${input.id} has duplicate keyframe frame ${keyframe.frame}`,
      );
    }
    keyframeFrames.add(keyframe.frame);

    validateValue(input.valueType, keyframe.value, keyframe.id);
    validateInterpolation(keyframe.outgoing, keyframe.id);
    return {
      id: keyframe.id,
      frame: keyframe.frame,
      value: keyframe.value,
      outgoing: keyframe.outgoing,
    };
  });

  keyframes.sort((left, right) => left.frame - right.frame || left.id.localeCompare(right.id));

  return {
    schemaVersion: NATIVE_KEYFRAME_SCHEMA_VERSION,
    id: input.id,
    parameterId: input.parameterId,
    valueType: input.valueType,
    frameRate,
    keyframes,
  };
};
