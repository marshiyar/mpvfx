/** Primitive validators and clone helpers shared by validation and parsing. */
import {
  NATIVE_KEYFRAME_SCHEMA_VERSION,
  NativeKeyframeValidationError,
  createNativeParameterTrack,
  validateRationalFrameRate,
  type NativeParameterValue,
  type NativeParameterTrack,
  type RationalFrameRate,
} from "./nativeKeyframeTypes";
import { sourceRangeFits } from "./nativeSourceTime";
import type {
  NativeClipDomBinding,
  NativePlaybackRate,
  NativeProjectDocumentValidationCode,
  NativeProjectDocumentValidationIssue,
  NativeProjectTrackLane,
} from "./nativeProjectDocumentTypes";

export type RecordValue = Record<string, unknown>;
export const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
export const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const isPositiveInteger = (value: unknown): value is number =>
  isNonNegativeInteger(value) && value > 0;

export const defaultTrackLane = (trackIndex: number): NativeProjectTrackLane => ({
  authoredTrack: trackIndex,
  displayTrack: trackIndex,
});

export function validateTrackLane(
  rawLane: unknown,
  trackIndex: number,
  path: string,
  issues: NativeProjectDocumentValidationIssue[],
): NativeProjectTrackLane | null {
  if (typeof rawLane === "undefined") return defaultTrackLane(trackIndex);
  if (!isRecord(rawLane)) {
    pushIssue(issues, "invalid-track", path, "Track lane metadata must be an object");
    return null;
  }
  let valid = true;
  if (!isNonNegativeInteger(rawLane.authoredTrack)) {
    pushIssue(
      issues,
      "invalid-track",
      `${path}.authoredTrack`,
      "Authored track must be a non-negative integer",
    );
    valid = false;
  }
  if (!isNonNegativeInteger(rawLane.displayTrack)) {
    pushIssue(
      issues,
      "invalid-track",
      `${path}.displayTrack`,
      "Display track must be a non-negative integer",
    );
    valid = false;
  }
  return valid
    ? {
        authoredTrack: rawLane.authoredTrack as number,
        displayTrack: rawLane.displayTrack as number,
      }
    : null;
}

export function pushIssue(
  issues: NativeProjectDocumentValidationIssue[],
  code: NativeProjectDocumentValidationCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

export function requireId(
  value: unknown,
  path: string,
  issues: NativeProjectDocumentValidationIssue[],
): value is string {
  if (isNonEmptyString(value)) return true;
  pushIssue(issues, "invalid-id", path, "Stable ID must be a non-empty string");
  return false;
}

export function collectDuplicateId(
  ids: Set<string>,
  value: unknown,
  path: string,
  issues: NativeProjectDocumentValidationIssue[],
): void {
  if (!isNonEmptyString(value)) return;
  if (ids.has(value)) {
    pushIssue(issues, "duplicate-id", path, `Duplicate stable ID ${value}`);
    return;
  }
  ids.add(value);
}

export function validateFrameRate(
  frameRate: unknown,
  path: string,
  issues: NativeProjectDocumentValidationIssue[],
): frameRate is RationalFrameRate {
  if (!isRecord(frameRate)) {
    pushIssue(issues, "invalid-frame-rate", path, "Frame rate must be an object");
    return false;
  }
  try {
    validateRationalFrameRate(frameRate as unknown as RationalFrameRate);
    return true;
  } catch (error) {
    pushIssue(
      issues,
      "invalid-frame-rate",
      path,
      error instanceof Error ? error.message : "Invalid rational frame rate",
    );
    return false;
  }
}

export function validatePlaybackRate(
  playbackRate: unknown,
  path: string,
  issues: NativeProjectDocumentValidationIssue[],
): playbackRate is NativePlaybackRate {
  if (!isRecord(playbackRate)) {
    pushIssue(
      issues,
      "invalid-playback-rate",
      path,
      "Playback rate must be an exact numerator/denominator object",
    );
    return false;
  }
  if (!isPositiveInteger(playbackRate.numerator) || !isPositiveInteger(playbackRate.denominator)) {
    pushIssue(
      issues,
      "invalid-playback-rate",
      path,
      "Playback rate numerator and denominator must be positive safe integers",
    );
    return false;
  }
  return true;
}

export function sourceRangeExceedsAsset(
  sourceInFrame: number,
  durationFrames: number,
  playbackRate: NativePlaybackRate,
  assetDurationFrames: number,
  sourceInFraction?: NativePlaybackRate,
): boolean {
  return !sourceRangeFits({ sourceInFrame, sourceInFraction, playbackRate }, durationFrames, assetDurationFrames);
}

export function validateParameterTracks(
  rawTracks: unknown,
  projectFrameRate: RationalFrameRate | null,
  clipDurationFrames: number | null,
  path: string,
  issues: NativeProjectDocumentValidationIssue[],
): rawTracks is NativeParameterTrack[] {
  if (!Array.isArray(rawTracks)) {
    pushIssue(issues, "invalid-parameter-track", path, "Parameter tracks must be an array");
    return false;
  }

  const ids = new Set<string>();
  const parameterIds = new Set<string>();
  rawTracks.forEach((rawTrack, index) => {
    const trackPath = `${path}[${index}]`;
    if (!isRecord(rawTrack)) {
      pushIssue(issues, "invalid-parameter-track", trackPath, "Parameter track must be an object");
      return;
    }
    collectDuplicateId(ids, rawTrack.id, `${trackPath}.id`, issues);
    if (isNonEmptyString(rawTrack.parameterId)) {
      if (parameterIds.has(rawTrack.parameterId)) {
        pushIssue(
          issues,
          "duplicate-id",
          `${trackPath}.parameterId`,
          `Duplicate parameter ID ${rawTrack.parameterId}`,
        );
      }
      parameterIds.add(rawTrack.parameterId);
    }
    if (rawTrack.schemaVersion !== NATIVE_KEYFRAME_SCHEMA_VERSION) {
      pushIssue(
        issues,
        "invalid-parameter-track",
        `${trackPath}.schemaVersion`,
        `Parameter track schemaVersion must be ${NATIVE_KEYFRAME_SCHEMA_VERSION}`,
      );
      return;
    }
    if (!isRecord(rawTrack.frameRate)) {
      pushIssue(issues, "invalid-parameter-track", `${trackPath}.frameRate`, "Missing frame rate");
      return;
    }
    if (
      projectFrameRate &&
      (rawTrack.frameRate.numerator !== projectFrameRate.numerator ||
        rawTrack.frameRate.denominator !== projectFrameRate.denominator)
    ) {
      pushIssue(
        issues,
        "invalid-parameter-track",
        `${trackPath}.frameRate`,
        "Parameter-track frame rate must match the project frame rate",
      );
    }
    if (rawTrack.autoRotate !== undefined && rawTrack.autoRotate !== true) {
      pushIssue(issues, "invalid-parameter-track", `${trackPath}.autoRotate`,
        "Auto-rotate must be true when present");
    }
    try {
      // The core owns keyframe, interpolation, value, and duplicate-keyframe
      // validation. Its constructor also sorts, but we intentionally discard that
      // result: parsing never silently changes authored document ordering.
      createNativeParameterTrack({
        id: rawTrack.id as string,
        parameterId: rawTrack.parameterId as string,
        valueType: rawTrack.valueType as never,
        frameRate: rawTrack.frameRate as unknown as RationalFrameRate,
        keyframes: rawTrack.keyframes as never,
        autoRotate: rawTrack.autoRotate as boolean | undefined,
      });
    } catch (error) {
      const message =
        error instanceof NativeKeyframeValidationError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Invalid parameter track";
      pushIssue(issues, "invalid-parameter-track", trackPath, message);
    }

    if (clipDurationFrames !== null && Array.isArray(rawTrack.keyframes)) {
      rawTrack.keyframes.forEach((rawKeyframe, keyframeIndex) => {
        if (
          isRecord(rawKeyframe) &&
          isNonNegativeInteger(rawKeyframe.frame) &&
          rawKeyframe.frame > clipDurationFrames
        ) {
          pushIssue(
            issues,
            "invalid-parameter-track",
            `${trackPath}.keyframes[${keyframeIndex}].frame`,
            `Keyframe frame ${rawKeyframe.frame} exceeds clip duration ${clipDurationFrames}`,
          );
        }
      });
    }
  });
  return true;
}

const STATIC_VEC2_KEYS = ["x", "y"] as const;
const STATIC_RGBA_KEYS = ["alpha", "blue", "green", "red"] as const;

function hasExactlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

function cloneStaticParameterValue(value: NativeParameterValue): NativeParameterValue {
  if (typeof value === "number") return value;
  if ("x" in value && "y" in value) return { x: value.x, y: value.y };
  return {
    red: value.red,
    green: value.green,
    blue: value.blue,
    alpha: value.alpha,
  };
}

export function cloneStaticParameters(
  value: Record<string, NativeParameterValue> | undefined,
): Record<string, NativeParameterValue> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, parameterValue]) => [
      key,
      cloneStaticParameterValue(parameterValue),
    ]),
  );
}

export function validateStaticParameters(
  rawParameters: unknown,
  path: string,
  issues: NativeProjectDocumentValidationIssue[],
): rawParameters is Record<string, NativeParameterValue> {
  if (typeof rawParameters === "undefined") return true;
  if (!isRecord(rawParameters)) {
    pushIssue(issues, "invalid-static-parameters", path, "Static parameters must be an object");
    return false;
  }

  for (const [parameterId, rawValue] of Object.entries(rawParameters)) {
    const valuePath = `${path}.${parameterId}`;
    if (!parameterId.trim()) {
      pushIssue(
        issues,
        "invalid-static-parameters",
        path,
        "Static parameter IDs must be non-empty strings",
      );
      continue;
    }
    if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue)) {
        pushIssue(issues, "invalid-static-parameters", valuePath, "Static number must be finite");
      }
      continue;
    }
    if (!isRecord(rawValue)) {
      pushIssue(
        issues,
        "invalid-static-parameters",
        valuePath,
        "Static parameter must be a finite number, vec2, or RGBA value",
      );
      continue;
    }

    if (hasExactlyKeys(rawValue, STATIC_VEC2_KEYS)) {
      if (!Number.isFinite(rawValue.x) || !Number.isFinite(rawValue.y)) {
        pushIssue(issues, "invalid-static-parameters", valuePath, "Vec2 components must be finite");
      }
      continue;
    }

    if (hasExactlyKeys(rawValue, STATIC_RGBA_KEYS)) {
      const channels = STATIC_RGBA_KEYS;
      const invalidChannel = channels.find(
        (channel) =>
          typeof rawValue[channel] !== "number" ||
          !Number.isFinite(rawValue[channel]) ||
          rawValue[channel] < 0 ||
          rawValue[channel] > 1,
      );
      if (invalidChannel) {
        pushIssue(
          issues,
          "invalid-static-parameters",
          `${valuePath}.${invalidChannel}`,
          "RGBA channels must be finite numbers between 0 and 1",
        );
      }
      continue;
    }

    pushIssue(
      issues,
      "invalid-static-parameters",
      valuePath,
      "Static object must contain exactly x/y or red/green/blue/alpha",
    );
  }
  return true;
}

export function validateClipBinding(
  rawBinding: unknown,
  path: string,
  bindingIdentities: Set<string>,
  issues: NativeProjectDocumentValidationIssue[],
): rawBinding is NativeClipDomBinding {
  if (!isRecord(rawBinding)) {
    pushIssue(issues, "invalid-binding", path, "Clip binding must be an object");
    return false;
  }

  const sourceFileValid = isNonEmptyString(rawBinding.sourceFile);
  if (!sourceFileValid) {
    pushIssue(
      issues,
      "invalid-binding",
      `${path}.sourceFile`,
      "Binding sourceFile must be a non-empty string",
    );
  }

  const identifiers = ["domId", "hfId", "selector"] as const;
  let hasIdentifier = false;
  for (const identifier of identifiers) {
    const value = rawBinding[identifier];
    if (typeof value === "undefined") continue;
    if (!isNonEmptyString(value)) {
      pushIssue(
        issues,
        "invalid-binding",
        `${path}.${identifier}`,
        `Binding ${identifier} must be a non-empty string when provided`,
      );
      continue;
    }
    hasIdentifier = true;
  }
  if (!hasIdentifier) {
    pushIssue(
      issues,
      "invalid-binding",
      path,
      "Binding must provide domId, hfId, or selector",
    );
  }

  if (typeof rawBinding.selectorIndex !== "undefined") {
    if (!isNonEmptyString(rawBinding.selector)) {
      pushIssue(
        issues,
        "invalid-binding",
        `${path}.selectorIndex`,
        "Binding selectorIndex requires a selector",
      );
    }
    if (!isNonNegativeInteger(rawBinding.selectorIndex)) {
      pushIssue(
        issues,
        "invalid-binding",
        `${path}.selectorIndex`,
        "Binding selectorIndex must be a non-negative integer",
      );
    }
  }

  if (!sourceFileValid) return false;
  const scopedIdentities: string[] = [];
  if (isNonEmptyString(rawBinding.domId)) {
    scopedIdentities.push(`${rawBinding.sourceFile}\u0000domId\u0000${rawBinding.domId}`);
  }
  if (isNonEmptyString(rawBinding.hfId)) {
    scopedIdentities.push(`${rawBinding.sourceFile}\u0000hfId\u0000${rawBinding.hfId}`);
  }
  if (isNonEmptyString(rawBinding.selector)) {
    scopedIdentities.push(
      `${rawBinding.sourceFile}\u0000selector\u0000${rawBinding.selector}\u0000${
        isNonNegativeInteger(rawBinding.selectorIndex) ? rawBinding.selectorIndex : 0
      }`,
    );
  }
  for (const identity of scopedIdentities) {
    if (bindingIdentities.has(identity)) {
      pushIssue(
        issues,
        "duplicate-binding",
        path,
        "Two native clips cannot share the same scoped DOM binding",
      );
    } else {
      bindingIdentities.add(identity);
    }
  }
  return true;
}

/**
 * Validate an untrusted document and return every detected issue. Unlike the
 * parser this never throws, which makes it suitable for import diagnostics.
 */
