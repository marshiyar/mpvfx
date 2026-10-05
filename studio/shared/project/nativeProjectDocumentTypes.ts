/** Public, media-first native project schema. No DOM or persistence dependencies. */
import type { NativeParameterValue, NativeParameterTrack, RationalFrameRate } from "./nativeKeyframeTypes";


export const NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const NATIVE_PROJECT_DOCUMENT_PATH = ".studio/project.json" as const;

/**
 * Media assets reference a project file. An "element" asset is an HTML-authored
 * layer (text, shape, group, nested composition): it has no source file, and
 * its clip exists so the engine can own that layer's timing and keyframes.
 */
export type NativeProjectAssetKind = "video" | "audio" | "image" | "element";

/** Asset kinds backed by a project media file. */
export type NativeMediaAssetKind = Exclude<NativeProjectAssetKind, "element">;

/** Whether clips of this kind read frames from a source file (trims, rate). */
export function nativeAssetConsumesSourceFrames(kind: NativeProjectAssetKind): boolean {
  return kind === "video" || kind === "audio";
}
export type NativeProjectTrackKind = "video" | "audio" | "mixed";

export interface NativeCanvas {
  width: number;
  height: number;
  background: string;
}

export interface NativeProjectAsset {
  id: string;
  kind: NativeProjectAssetKind;
  name: string;
  /** Media location owned by the project, independent of any preview element. */
  source?: string;
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

/** Opt-in visible-crop pivot for one authored rotation interval. Key IDs keep
 * the interval attached when its frames move; normalized offsets follow size. */
export interface NativeCropPivotSegment {
  startRotationKeyId: string;
  endRotationKeyId: string;
  offsetFraction: { x: number; y: number };
  /** Original interpolation survives generated boundary keys from a split/trim. */
  reference?: {
    frameOffset: number;
    durationFrames: number;
    startRotationKeyId: string;
    endRotationKeyId: string;
    parameterTracks: NativeParameterTrack[];
    staticParameters?: Record<string, NativeParameterValue>;
  };
}

export interface NativeProjectClip {
  id: string;
  assetId: string;
  /** Audio bus membership. Video keeps its picture and contributes only its sound. */
  audioGroupId?: string;
  /** Serialized clip-level audio processing, matching the HTML media attributes. */
  audioFxChain?: string;
  audioAutomation?: string;
  /** Stable source video clip ID for an extracted audio clip. It survives edits. */
  audioDetachedFrom?: string;
  binding?: NativeClipDomBinding;
  startFrame: number;
  durationFrames: number;
  sourceInFrame: number;
  sourceInFraction?: NativePlaybackRate;
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
  cropPivotSegments?: NativeCropPivotSegment[];
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
  /** Optional explicit end, including an authored blank tail. */
  durationFrames?: number;
  /** Optional in v1 documents. The group is an audio bus, never a timeline clip. */
  audioGroups?: NativeAudioGroup[];
  tracks: NativeProjectTrack[];
}

export interface NativeAudioGroup {
  id: string;
  label?: string;
  /** Linear gain, matching the HTML audio-group fader. */
  volume?: number;
  muted?: boolean;
  /** Serialized shared Web Audio processing, as on an HTML group element. */
  fxChain?: string;
  automation?: string;
}

export interface NativeProjectDocument {
  schemaVersion: typeof NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION;
  /** Present only after project data owns the complete renderable sequence. */
  mediaEngine?: "ffmpeg";
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
