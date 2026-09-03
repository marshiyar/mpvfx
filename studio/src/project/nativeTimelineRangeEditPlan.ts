import type { NativeProjectDocument } from "./nativeProjectDocument";
import {
  applyNativeProjectClipCommand,
  type NativeProjectClipAddress,
  type NativeProjectClipFailureCode,
} from "./nativeProjectClipCommands";
import {
  projectFrameFromSeconds,
  resolveNativeClipSelection,
  type NativeSelectedElementReference,
} from "./nativePropertyEditPlan";

export type NativeTimelineRangeEditKind = "trim-in" | "trim-out";

export interface NativeTimelineRangeEditElement extends NativeSelectedElementReference {}

export interface NativeTimelineRangeEditPlanInput {
  readonly document: NativeProjectDocument;
  readonly element: NativeTimelineRangeEditElement;
  readonly requestedStartSeconds: number;
  readonly requestedDurationSeconds: number;
}

export interface NativeTimelineCompatibilityRange {
  /** Exact native-frame-derived decimal used only by the transitional HTML mirror. */
  readonly start: string;
  /** Exact native-frame-derived decimal used only by the transitional HTML mirror. */
  readonly duration: string;
  /** Exact native source-in frame expressed in project-frame seconds. */
  readonly sourceOffset: string;
}

export type NativeTimelineRangeEditPlanFailureCode =
  | "invalid-range"
  | "no-change"
  | "unsupported-range-change"
  | "missing-selection-id"
  | "clip-not-found"
  | "ambiguous-clip"
  | "unbound-clip"
  | "native-command-rejected";

export type NativeTimelineRangeEditPlanResult =
  | {
      readonly ok: true;
      readonly kind: NativeTimelineRangeEditKind;
      readonly document: NativeProjectDocument;
      readonly address: NativeProjectClipAddress;
      readonly sourceFile: string;
      readonly startFrame: number;
      readonly durationFrames: number;
      readonly endFrameExclusive: number;
      readonly sourceInFrame: number;
      readonly compatibility: NativeTimelineCompatibilityRange;
    }
  | {
      readonly ok: false;
      readonly failure: {
        readonly code: NativeTimelineRangeEditPlanFailureCode;
        readonly message: string;
        readonly nativeCode?: NativeProjectClipFailureCode;
      };
    };

const fail = (
  code: NativeTimelineRangeEditPlanFailureCode,
  message: string,
  nativeCode?: NativeProjectClipFailureCode,
): NativeTimelineRangeEditPlanResult => ({
  ok: false,
  failure: { code, message, ...(nativeCode ? { nativeCode } : {}) },
});

const compatibilitySeconds = (
  frame: number,
  frameRate: NativeProjectDocument["frameRate"],
): string => String((frame * frameRate.denominator) / frameRate.numerator);

const locateUpdatedClip = (
  document: NativeProjectDocument,
  address: NativeProjectClipAddress,
) => document.sequence.tracks
  .find((track) => track.id === address.trackId)
  ?.clips.find((clip) => clip.id === address.clipId);

/**
 * Plan one native-canonical range edit from the same start/duration values the
 * timeline resize surface emits. Exactly one boundary may move. Native integer
 * frames and the clip command's rational playback-rate math are authoritative;
 * decimal strings are derived only after the native command succeeds.
 */
export function planNativeTimelineRangeEdit(
  input: NativeTimelineRangeEditPlanInput,
): NativeTimelineRangeEditPlanResult {
  if (
    !Number.isFinite(input.requestedStartSeconds) ||
    input.requestedStartSeconds < 0 ||
    !Number.isFinite(input.requestedDurationSeconds) ||
    input.requestedDurationSeconds <= 0
  ) {
    return fail("invalid-range", "Native timeline range must have a finite start and positive duration");
  }

  let startFrame: number;
  let durationFrames: number;
  try {
    startFrame = projectFrameFromSeconds(input.requestedStartSeconds, input.document.frameRate);
    durationFrames = projectFrameFromSeconds(
      input.requestedDurationSeconds,
      input.document.frameRate,
    );
  } catch (error) {
    return fail("invalid-range", error instanceof Error ? error.message : "Invalid native range");
  }
  const endFrameExclusive = startFrame + durationFrames;
  if (
    durationFrames <= 0 ||
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(durationFrames) ||
    !Number.isSafeInteger(endFrameExclusive)
  ) {
    return fail("invalid-range", "Native timeline range must resolve to safe integral frames");
  }

  const resolution = resolveNativeClipSelection(input.document, input.element);
  if (!resolution.ok) {
    const code = resolution.failure.code;
    if (code === "missing-selection-id" || code === "clip-not-found" || code === "ambiguous-clip") {
      return fail(code, resolution.failure.message);
    }
    return fail("clip-not-found", resolution.failure.message);
  }

  const { clip, trackId } = resolution.located;
  const binding = clip.binding;
  if (!binding || !input.element.sourceFile || binding.sourceFile !== input.element.sourceFile) {
    return fail("unbound-clip", `Native clip ${clip.id} has no exact compatibility binding`);
  }

  const oldEndFrameExclusive = clip.startFrame + clip.durationFrames;
  const startChanged = startFrame !== clip.startFrame;
  const endChanged = endFrameExclusive !== oldEndFrameExclusive;
  if (!startChanged && !endChanged) {
    return fail("no-change", "Native timeline range is unchanged");
  }
  if (startChanged === endChanged) {
    return fail(
      "unsupported-range-change",
      "A native timeline range edit must move exactly one clip boundary",
    );
  }

  const kind: NativeTimelineRangeEditKind = startChanged ? "trim-in" : "trim-out";
  const address: NativeProjectClipAddress = {
    sequenceId: input.document.sequence.id,
    trackId,
    clipId: clip.id,
  };
  const command = applyNativeProjectClipCommand(
    input.document,
    kind === "trim-in"
      ? { type: "trim-in", address, startFrame }
      : { type: "trim-out", address, endFrameExclusive },
  );
  if (!command.ok) {
    return fail("native-command-rejected", command.failure.message, command.failure.code);
  }

  const updatedClip = locateUpdatedClip(command.document, address);
  if (!updatedClip) {
    return fail("native-command-rejected", `Native clip ${clip.id} disappeared during range edit`);
  }

  const updatedEndFrameExclusive = updatedClip.startFrame + updatedClip.durationFrames;
  return {
    ok: true,
    kind,
    document: command.document,
    address,
    sourceFile: binding.sourceFile,
    startFrame: updatedClip.startFrame,
    durationFrames: updatedClip.durationFrames,
    endFrameExclusive: updatedEndFrameExclusive,
    sourceInFrame: updatedClip.sourceInFrame,
    compatibility: {
      start: compatibilitySeconds(updatedClip.startFrame, input.document.frameRate),
      duration: compatibilitySeconds(updatedClip.durationFrames, input.document.frameRate),
      sourceOffset: compatibilitySeconds(updatedClip.sourceInFrame, input.document.frameRate),
    },
  };
}
