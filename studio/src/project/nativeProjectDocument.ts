/**
 * The standalone editor's durable, media-first project contract.
 *
 * This deliberately knows nothing about DOM nodes, GSAP, HTML, or filesystem
 * access. Those are adapters around this document, never canonical identity.
 */
import {
  NATIVE_KEYFRAME_SCHEMA_VERSION,
  NativeKeyframeValidationError,
  createNativeParameterTrack,
  validateRationalFrameRate,
  type NativeParameterValue,
  type NativeParameterTrack,
  type RationalFrameRate,
} from "./nativeKeyframeTypes";

export const NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const NATIVE_PROJECT_DOCUMENT_PATH = ".studio/project.json" as const;

export type NativeProjectAssetKind = "video" | "audio" | "image";
export type NativeProjectTrackKind = "video" | "audio";

export interface NativeCanvas {
  width: number;
  height: number;
  background: string;
}

export interface NativeProjectAsset {
  id: string;
  kind: NativeProjectAssetKind;
  name: string;
  durationFrames: number;
}

export interface NativeClipEffect {
  id: string;
  effectId: string;
  enabled: boolean;
  parameters?: Record<string, unknown>;
}

/**
 * Exact source-time multiplier: source frames consumed per timeline frame.
 * Integers avoid nondeterministic float accumulation during trims and splits.
 */
export interface NativePlaybackRate {
  numerator: number;
  denominator: number;
}

export const DEFAULT_NATIVE_PLAYBACK_RATE: Readonly<NativePlaybackRate> = Object.freeze({
  numerator: 1,
  denominator: 1,
});

/**
 * A scoped bridge from a native clip to legacy preview markup. This is not the
 * clip's identity: `NativeProjectClip.id` remains the durable project ID.
 */
export interface NativeClipDomBinding {
  sourceFile: string;
  domId?: string;
  hfId?: string;
  selector?: string;
  selectorIndex?: number;
}

export interface NativeProjectClip {
  id: string;
  assetId: string;
  binding?: NativeClipDomBinding;
  startFrame: number;
  durationFrames: number;
  sourceInFrame: number;
  /** Missing only in v1 input; the parser materializes the exact 1/1 default. */
  playbackRate?: NativePlaybackRate;
  /** Missing only in v1 input; it is materialized to this safe default. */
  muted: boolean;
  /** Static/default values for properties without a parameter track.
   *
   * Optional on the structural type so existing v1 callers that construct a
   * clip literal continue to compile; parseNativeProjectDocument always
   * materializes it to an object (including `{}` when omitted).
   */
  staticParameters?: Record<string, NativeParameterValue>;
  effects: NativeClipEffect[];
  parameterTracks: NativeParameterTrack[];
}

/**
 * Exact mapping between the source file's authored lane and Studio's current
 * display row. It is durable project data; neither value is reconstructed from
 * a track ID, whose only responsibility is stable identity.
 */
export interface NativeProjectTrackLane {
  authoredTrack: number;
  displayTrack: number;
}

export interface NativeProjectTrack {
  id: string;
  kind: NativeProjectTrackKind;
  /**
   * Optional only for source compatibility with early v1 callers. The parser
   * always materializes a deterministic lane mapping.
   */
  lane?: NativeProjectTrackLane;
  clips: NativeProjectClip[];
}

export interface NativeProjectSequence {
  id: string;
  name: string;
  tracks: NativeProjectTrack[];
}

export interface NativeProjectDocument {
  schemaVersion: typeof NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION;
  id: string;
  revision: number;
  frameRate: RationalFrameRate;
  canvas: NativeCanvas;
  assets: NativeProjectAsset[];
  sequence: NativeProjectSequence;
}

/** Input permits the v1 `muted` default before the parser materializes it. */
export interface NativeProjectDocumentInput extends Omit<NativeProjectDocument, "sequence"> {
  sequence: Omit<NativeProjectSequence, "tracks"> & {
    tracks: Array<Omit<NativeProjectTrack, "clips"> & {
      clips: Array<
        Omit<NativeProjectClip, "muted" | "staticParameters"> & {
          muted?: boolean;
          staticParameters?: Record<string, NativeParameterValue>;
        }
      >;
    }>;
  };
}

export type NativeProjectDocumentValidationCode =
  | "invalid-root"
  | "unsupported-schema-version"
  | "invalid-id"
  | "duplicate-id"
  | "invalid-revision"
  | "invalid-frame-rate"
  | "invalid-canvas"
  | "invalid-asset"
  | "invalid-track"
  | "invalid-clip"
  | "invalid-playback-rate"
  | "invalid-binding"
  | "duplicate-binding"
  | "invalid-effect"
  | "invalid-static-parameters"
  | "missing-reference"
  | "media-type-mismatch"
  | "source-out-of-bounds"
  | "invalid-parameter-track";

export interface NativeProjectDocumentValidationIssue {
  code: NativeProjectDocumentValidationCode;
  path: string;
  message: string;
}

export class NativeProjectDocumentValidationError extends Error {
  readonly issues: readonly NativeProjectDocumentValidationIssue[];

  constructor(issues: readonly NativeProjectDocumentValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "NativeProjectDocumentValidationError";
    this.issues = issues;
  }
}

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number =>
  isNonNegativeInteger(value) && value > 0;

const defaultTrackLane = (trackIndex: number): NativeProjectTrackLane => ({
  authoredTrack: trackIndex,
  displayTrack: trackIndex,
});

function validateTrackLane(
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

function pushIssue(
  issues: NativeProjectDocumentValidationIssue[],
  code: NativeProjectDocumentValidationCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function requireId(
  value: unknown,
  path: string,
  issues: NativeProjectDocumentValidationIssue[],
): value is string {
  if (isNonEmptyString(value)) return true;
  pushIssue(issues, "invalid-id", path, "Stable ID must be a non-empty string");
  return false;
}

function collectDuplicateId(
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

function validateFrameRate(
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

function validatePlaybackRate(
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

function sourceRangeExceedsAsset(
  sourceInFrame: number,
  durationFrames: number,
  playbackRate: NativePlaybackRate,
  assetDurationFrames: number,
): boolean {
  const denominator = BigInt(playbackRate.denominator);
  const sourceEndNumerator =
    BigInt(sourceInFrame) * denominator +
    BigInt(durationFrames) * BigInt(playbackRate.numerator);
  return sourceEndNumerator > BigInt(assetDurationFrames) * denominator;
}

function validateParameterTracks(
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

function cloneStaticParameters(
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

function validateStaticParameters(
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

function validateClipBinding(
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
export function validateNativeProjectDocument(
  input: unknown,
): NativeProjectDocumentValidationIssue[] {
  const issues: NativeProjectDocumentValidationIssue[] = [];
  if (!isRecord(input)) {
    pushIssue(issues, "invalid-root", "", "Project document must be an object");
    return issues;
  }

  if (input.schemaVersion !== NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION) {
    pushIssue(
      issues,
      "unsupported-schema-version",
      "schemaVersion",
      `Project schemaVersion must be ${NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION}`,
    );
  }
  requireId(input.id, "id", issues);
  if (!isNonNegativeInteger(input.revision)) {
    pushIssue(issues, "invalid-revision", "revision", "Revision must be a non-negative integer");
  }
  const projectFrameRate = validateFrameRate(input.frameRate, "frameRate", issues)
    ? input.frameRate
    : null;

  if (!isRecord(input.canvas)) {
    pushIssue(issues, "invalid-canvas", "canvas", "Canvas must be an object");
  } else {
    if (!isPositiveInteger(input.canvas.width)) {
      pushIssue(issues, "invalid-canvas", "canvas.width", "Canvas width must be a positive integer");
    }
    if (!isPositiveInteger(input.canvas.height)) {
      pushIssue(issues, "invalid-canvas", "canvas.height", "Canvas height must be a positive integer");
    }
    if (!isNonEmptyString(input.canvas.background)) {
      pushIssue(issues, "invalid-canvas", "canvas.background", "Canvas background must be a non-empty string");
    }
  }

  const assetsById = new Map<string, RecordValue>();
  if (!Array.isArray(input.assets)) {
    pushIssue(issues, "invalid-asset", "assets", "Assets must be an array");
  } else {
    const assetIds = new Set<string>();
    input.assets.forEach((asset, index) => {
      const path = `assets[${index}]`;
      if (!isRecord(asset)) {
        pushIssue(issues, "invalid-asset", path, "Asset must be an object");
        return;
      }
      requireId(asset.id, `${path}.id`, issues);
      collectDuplicateId(assetIds, asset.id, `${path}.id`, issues);
      if (isNonEmptyString(asset.id) && !assetsById.has(asset.id)) assetsById.set(asset.id, asset);
      if (asset.kind !== "video" && asset.kind !== "audio" && asset.kind !== "image") {
        pushIssue(issues, "invalid-asset", `${path}.kind`, "Asset kind must be video, audio, or image");
      }
      if (!isNonEmptyString(asset.name)) {
        pushIssue(issues, "invalid-asset", `${path}.name`, "Asset name must be a non-empty string");
      }
      if (!isPositiveInteger(asset.durationFrames)) {
        pushIssue(issues, "invalid-asset", `${path}.durationFrames`, "Asset duration must be a positive integer");
      }
    });
  }

  if (!isRecord(input.sequence)) {
    pushIssue(issues, "invalid-track", "sequence", "Sequence must be an object");
    return issues;
  }
  requireId(input.sequence.id, "sequence.id", issues);
  if (!isNonEmptyString(input.sequence.name)) {
    pushIssue(issues, "invalid-track", "sequence.name", "Sequence name must be a non-empty string");
  }
  if (!Array.isArray(input.sequence.tracks)) {
    pushIssue(issues, "invalid-track", "sequence.tracks", "Tracks must be an array");
    return issues;
  }

  const trackIds = new Set<string>();
  const authoredLaneIds = new Set<string>();
  const displayLaneIds = new Set<number>();
  const clipIds = new Set<string>();
  const bindingIdentities = new Set<string>();
  input.sequence.tracks.forEach((track, trackIndex) => {
    const trackPath = `sequence.tracks[${trackIndex}]`;
    if (!isRecord(track)) {
      pushIssue(issues, "invalid-track", trackPath, "Track must be an object");
      return;
    }
    requireId(track.id, `${trackPath}.id`, issues);
    collectDuplicateId(trackIds, track.id, `${trackPath}.id`, issues);
    if (track.kind !== "video" && track.kind !== "audio") {
      pushIssue(issues, "invalid-track", `${trackPath}.kind`, "Track kind must be video or audio");
    }
    const lane = validateTrackLane(track.lane, trackIndex, `${trackPath}.lane`, issues);
    if (lane) {
      if (displayLaneIds.has(lane.displayTrack)) {
        pushIssue(
          issues,
          "invalid-track",
          `${trackPath}.lane.displayTrack`,
          `Display track ${lane.displayTrack} is already mapped by another native track`,
        );
      } else {
        displayLaneIds.add(lane.displayTrack);
      }
      if (track.kind === "video" || track.kind === "audio") {
        const authoredLaneId = `${track.kind}\u0000${lane.authoredTrack}`;
        if (authoredLaneIds.has(authoredLaneId)) {
          pushIssue(
            issues,
            "invalid-track",
            `${trackPath}.lane.authoredTrack`,
            `${track.kind} authored track ${lane.authoredTrack} is already mapped`,
          );
        } else {
          authoredLaneIds.add(authoredLaneId);
        }
      }
    }
    if (!Array.isArray(track.clips)) {
      pushIssue(issues, "invalid-track", `${trackPath}.clips`, "Track clips must be an array");
      return;
    }
    track.clips.forEach((clip, clipIndex) => {
      const clipPath = `${trackPath}.clips[${clipIndex}]`;
      if (!isRecord(clip)) {
        pushIssue(issues, "invalid-clip", clipPath, "Clip must be an object");
        return;
      }
      requireId(clip.id, `${clipPath}.id`, issues);
      collectDuplicateId(clipIds, clip.id, `${clipPath}.id`, issues);
      if (typeof clip.binding !== "undefined") {
        validateClipBinding(clip.binding, `${clipPath}.binding`, bindingIdentities, issues);
      }
      if (!isNonEmptyString(clip.assetId)) {
        pushIssue(issues, "missing-reference", `${clipPath}.assetId`, "Clip assetId must be a non-empty string");
      }
      const asset = isNonEmptyString(clip.assetId) ? assetsById.get(clip.assetId) : undefined;
      if (!asset && isNonEmptyString(clip.assetId)) {
        pushIssue(issues, "missing-reference", `${clipPath}.assetId`, `Missing asset ${clip.assetId}`);
      }
      if (
        asset &&
        ((track.kind === "audio" && asset.kind !== "audio") ||
          (track.kind === "video" && asset.kind !== "video" && asset.kind !== "image"))
      ) {
        pushIssue(issues, "media-type-mismatch", `${clipPath}.assetId`, "Asset kind does not match track kind");
      }
      for (const [name, value, positive] of [
        ["startFrame", clip.startFrame, false],
        ["durationFrames", clip.durationFrames, true],
        ["sourceInFrame", clip.sourceInFrame, false],
      ] as const) {
        if ((positive ? !isPositiveInteger(value) : !isNonNegativeInteger(value))) {
          pushIssue(
            issues,
            "invalid-clip",
            `${clipPath}.${name}`,
            `${name} must be a ${positive ? "positive" : "non-negative"} integer`,
          );
        }
      }
      const playbackRate =
        typeof clip.playbackRate === "undefined"
          ? DEFAULT_NATIVE_PLAYBACK_RATE
          : validatePlaybackRate(clip.playbackRate, `${clipPath}.playbackRate`, issues)
            ? clip.playbackRate
            : null;
      if (typeof clip.muted !== "undefined" && typeof clip.muted !== "boolean") {
        pushIssue(issues, "invalid-clip", `${clipPath}.muted`, "Muted must be a boolean");
      }
      validateStaticParameters(clip.staticParameters, `${clipPath}.staticParameters`, issues);
      if (
        asset &&
        isNonNegativeInteger(clip.sourceInFrame) &&
        isPositiveInteger(clip.durationFrames) &&
        isPositiveInteger(asset.durationFrames) &&
        playbackRate &&
        sourceRangeExceedsAsset(
          clip.sourceInFrame,
          clip.durationFrames,
          playbackRate,
          asset.durationFrames,
        )
      ) {
        pushIssue(
          issues,
          "source-out-of-bounds",
          clipPath,
          "Clip source range exceeds its asset duration",
        );
      }
      if (!Array.isArray(clip.effects)) {
        pushIssue(issues, "invalid-effect", `${clipPath}.effects`, "Effects must be an array");
      } else {
        const effectIds = new Set<string>();
        clip.effects.forEach((effect, effectIndex) => {
          const effectPath = `${clipPath}.effects[${effectIndex}]`;
          if (!isRecord(effect)) {
            pushIssue(issues, "invalid-effect", effectPath, "Effect must be an object");
            return;
          }
          requireId(effect.id, `${effectPath}.id`, issues);
          collectDuplicateId(effectIds, effect.id, `${effectPath}.id`, issues);
          if (!isNonEmptyString(effect.effectId)) {
            pushIssue(issues, "invalid-effect", `${effectPath}.effectId`, "Effect ID must be a non-empty string");
          }
          if (typeof effect.enabled !== "boolean") {
            pushIssue(issues, "invalid-effect", `${effectPath}.enabled`, "Effect enabled must be a boolean");
          }
          if (typeof effect.parameters !== "undefined" && !isRecord(effect.parameters)) {
            pushIssue(issues, "invalid-effect", `${effectPath}.parameters`, "Effect parameters must be an object");
          }
        });
      }
      validateParameterTracks(
        clip.parameterTracks,
        projectFrameRate,
        isPositiveInteger(clip.durationFrames) ? clip.durationFrames : null,
        `${clipPath}.parameterTracks`,
        issues,
      );
    });
  });

  return issues;
}

/** Parse only a fully valid v1 document. Invalid input is never repaired. */
export function parseNativeProjectDocument(input: unknown): NativeProjectDocument {
  const issues = validateNativeProjectDocument(input);
  if (issues.length > 0) throw new NativeProjectDocumentValidationError(issues);
  const document = input as NativeProjectDocumentInput;
  return {
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: document.id,
    revision: document.revision,
    frameRate: { ...document.frameRate },
    canvas: { ...document.canvas },
    assets: document.assets.map((asset) => ({ ...asset })),
    sequence: {
      id: document.sequence.id,
      name: document.sequence.name,
      tracks: document.sequence.tracks.map((track, trackIndex) => ({
        id: track.id,
        kind: track.kind,
        lane: {
          ...(track.lane ?? defaultTrackLane(trackIndex)),
        },
        clips: track.clips.map((clip) => ({
          id: clip.id,
          assetId: clip.assetId,
          ...(clip.binding
            ? {
                binding: {
                  sourceFile: clip.binding.sourceFile,
                  ...(clip.binding.domId ? { domId: clip.binding.domId } : {}),
                  ...(clip.binding.hfId ? { hfId: clip.binding.hfId } : {}),
                  ...(clip.binding.selector ? { selector: clip.binding.selector } : {}),
                  ...(typeof clip.binding.selectorIndex === "number"
                    ? { selectorIndex: clip.binding.selectorIndex }
                    : {}),
                },
              }
            : {}),
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          sourceInFrame: clip.sourceInFrame,
          playbackRate: {
            numerator: clip.playbackRate?.numerator ?? DEFAULT_NATIVE_PLAYBACK_RATE.numerator,
            denominator: clip.playbackRate?.denominator ?? DEFAULT_NATIVE_PLAYBACK_RATE.denominator,
          },
          muted: clip.muted ?? false,
          staticParameters: cloneStaticParameters(clip.staticParameters),
          effects: clip.effects.map((effect) => ({
            ...effect,
            ...(effect.parameters ? { parameters: { ...effect.parameters } } : {}),
          })),
          parameterTracks: clip.parameterTracks.map((track) => track),
        })),
      })),
    },
  };
}

export type NativeProjectTrackLaneQuery =
  | {
      readonly kind: NativeProjectTrackKind;
      readonly authoredTrack: number;
      readonly displayTrack?: number;
    }
  | {
      readonly kind: NativeProjectTrackKind;
      readonly displayTrack: number;
      readonly authoredTrack?: number;
    };

/**
 * Resolve a native track from explicit lane metadata. Early in-memory v1
 * objects that bypassed the parser retain the same deterministic index fallback
 * as parseNativeProjectDocument; track IDs are never inspected.
 */
export function findNativeProjectTrackByLane(
  document: NativeProjectDocument,
  query: NativeProjectTrackLaneQuery,
): NativeProjectTrack | null {
  const matches = document.sequence.tracks.filter((track, trackIndex) => {
    if (track.kind !== query.kind) return false;
    const lane = track.lane ?? defaultTrackLane(trackIndex);
    return (
      (query.authoredTrack === undefined || lane.authoredTrack === query.authoredTrack) &&
      (query.displayTrack === undefined || lane.displayTrack === query.displayTrack)
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

/** Validate then write stable JSON with ordered arrays and canonical object keys. */
export function serializeNativeProjectDocument(document: unknown): string {
  return `${JSON.stringify(canonicalize(parseNativeProjectDocument(document)), null, 2)}\n`;
}
