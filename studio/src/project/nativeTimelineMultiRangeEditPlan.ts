import type {
  NativeClipDomBinding,
  NativeProjectDocument,
} from "./nativeProjectDocument";
import type { NativeProjectClipAddress } from "./nativeProjectClipCommands";
import type { NativeSelectedElementReference } from "./nativePropertyEditPlan";
import {
  planNativeTimelineRangeEdit,
  type NativeTimelineCompatibilityRange,
  type NativeTimelineRangeEditKind,
  type NativeTimelineRangeEditPlanFailureCode,
} from "./nativeTimelineRangeEditPlan";

export interface NativeTimelineMultiRangeEditChange {
  readonly element: NativeSelectedElementReference;
  readonly requestedStartSeconds: number;
  readonly requestedDurationSeconds: number;
}

export interface NativeTimelineMultiRangeEditPlanInput {
  readonly document: NativeProjectDocument;
  readonly changes: readonly NativeTimelineMultiRangeEditChange[];
}

export interface NativeTimelineMultiRangePlannedEdit {
  readonly address: NativeProjectClipAddress;
  readonly sourceFile: string;
  readonly binding: Readonly<NativeClipDomBinding>;
  readonly kind: NativeTimelineRangeEditKind;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly endFrameExclusive: number;
  readonly sourceInFrame: number;
  readonly compatibility: NativeTimelineCompatibilityRange;
}

export type NativeTimelineMultiRangeEditPlanFailureCode =
  | NativeTimelineRangeEditPlanFailureCode
  | "empty-change-set"
  | "duplicate-clip"
  | "binding-source-mismatch";

export type NativeTimelineMultiRangeEditPlanResult =
  | {
      readonly ok: true;
      readonly document: NativeProjectDocument;
      readonly edits: readonly NativeTimelineMultiRangePlannedEdit[];
      readonly sourceFiles: readonly string[];
    }
  | {
      readonly ok: false;
      readonly failure: {
        readonly code: NativeTimelineMultiRangeEditPlanFailureCode;
        readonly message: string;
        readonly changeIndex?: number;
      };
    };

const fail = (
  code: NativeTimelineMultiRangeEditPlanFailureCode,
  message: string,
  changeIndex?: number,
): NativeTimelineMultiRangeEditPlanResult => ({
  ok: false,
  failure: {
    code,
    message,
    ...(changeIndex === undefined ? {} : { changeIndex }),
  },
});

const addressKey = (address: NativeProjectClipAddress): string =>
  JSON.stringify([address.sequenceId, address.trackId, address.clipId]);

const locateBinding = (
  document: NativeProjectDocument,
  address: NativeProjectClipAddress,
): NativeClipDomBinding | undefined => document.sequence.tracks
  .find((track) => track.id === address.trackId)
  ?.clips.find((clip) => clip.id === address.clipId)
  ?.binding;

/**
 * Plan an entire multi-selection trim against one immutable project snapshot.
 * Every member is first resolved and validated against that same snapshot, so
 * duplicate aliases and a late invalid member cannot yield a partial project.
 * Only after preflight succeeds are the immutable native trim commands applied.
 */
export function planNativeTimelineMultiRangeEdit(
  input: NativeTimelineMultiRangeEditPlanInput,
): NativeTimelineMultiRangeEditPlanResult {
  if (input.changes.length === 0) {
    return fail("empty-change-set", "A native multi-clip range edit requires at least one change");
  }

  const addressed = new Set<string>();
  const preflight: Array<{
    readonly change: NativeTimelineMultiRangeEditChange;
    readonly address: NativeProjectClipAddress;
    readonly sourceFile: string;
    readonly binding: Readonly<NativeClipDomBinding>;
  }> = [];

  for (const [changeIndex, change] of input.changes.entries()) {
    const candidate = planNativeTimelineRangeEdit({
      document: input.document,
      element: change.element,
      requestedStartSeconds: change.requestedStartSeconds,
      requestedDurationSeconds: change.requestedDurationSeconds,
    });
    if (!candidate.ok) {
      return fail(candidate.failure.code, candidate.failure.message, changeIndex);
    }

    const key = addressKey(candidate.address);
    if (addressed.has(key)) {
      return fail(
        "duplicate-clip",
        `Native clip ${candidate.address.clipId} is targeted more than once by the same range edit`,
        changeIndex,
      );
    }
    addressed.add(key);

    const binding = locateBinding(input.document, candidate.address);
    if (!binding) {
      return fail(
        "unbound-clip",
        `Native clip ${candidate.address.clipId} has no compatibility source binding`,
        changeIndex,
      );
    }
    if (binding.sourceFile !== candidate.sourceFile) {
      return fail(
        "binding-source-mismatch",
        `Resolved source ${candidate.sourceFile} does not match native binding ${binding.sourceFile}`,
        changeIndex,
      );
    }
    preflight.push({
      change,
      address: candidate.address,
      sourceFile: candidate.sourceFile,
      binding: { ...binding },
    });
  }

  let document = input.document;
  const edits: NativeTimelineMultiRangePlannedEdit[] = [];
  for (const [changeIndex, item] of preflight.entries()) {
    const result = planNativeTimelineRangeEdit({
      document,
      element: item.change.element,
      requestedStartSeconds: item.change.requestedStartSeconds,
      requestedDurationSeconds: item.change.requestedDurationSeconds,
    });
    if (!result.ok) {
      return fail(result.failure.code, result.failure.message, changeIndex);
    }
    document = result.document;
    edits.push({
      address: result.address,
      sourceFile: item.sourceFile,
      binding: item.binding,
      kind: result.kind,
      startFrame: result.startFrame,
      durationFrames: result.durationFrames,
      endFrameExclusive: result.endFrameExclusive,
      sourceInFrame: result.sourceInFrame,
      compatibility: result.compatibility,
    });
  }

  return {
    ok: true,
    document,
    edits,
    sourceFiles: [...new Set(edits.map((edit) => edit.sourceFile))].sort(),
  };
}
