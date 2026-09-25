import { VkfTrackError, vkfEngine } from "../engine/vkfEngine";

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
  const keyframes = input.keyframes.map((keyframe) => {
    validateStableId(keyframe.id, "keyframe");
    if (keyframeIds.has(keyframe.id)) {
      throwValidation(
        "duplicate-keyframe-id",
        `Parameter track ${input.id} has duplicate keyframe ID ${keyframe.id}`,
      );
    }
    keyframeIds.add(keyframe.id);
    return {
      id: keyframe.id,
      frame: keyframe.frame,
      value: keyframe.value,
      outgoing: keyframe.outgoing,
    };
  });

  // Frames, values and interpolation are engine rules: the C++ engine rejects
  // exactly what it cannot evaluate, so the project and the evaluator agree.
  try {
    vkfEngine().validate({ valueType: input.valueType, keyframes });
  } catch (error) {
    if (error instanceof VkfTrackError) {
      throwValidation(error.code, `Parameter track ${input.id}: ${error.message}`);
    }
    throw error;
  }

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
