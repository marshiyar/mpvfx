import type {
  NativeClipDomBinding,
  NativeProjectDocument,
} from "./nativeProjectDocument";
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

/** A nested/expanded row reports master time for a source-local clip. Until the
 * native sequence models nesting explicitly, accepting it would split at an
 * ambiguous boundary, so the planner rejects it without falling back to math. */
export interface NativeTimelineSplitElement extends NativeSelectedElementReference {
  readonly expandedParentStart?: number;
  readonly expandedHostKey?: string;
  readonly parentCompositionId?: string | null;
}

export interface NativeTimelineSplitRequest {
  readonly element: NativeTimelineSplitElement;
  readonly requestedSplitSeconds: number;
  /** Identity returned by the compatibility transform, never guessed here. */
  readonly rightBinding: Readonly<NativeClipDomBinding>;
}

export interface NativeTimelineSplitPlanInput {
  readonly document: NativeProjectDocument;
  readonly splits: readonly NativeTimelineSplitRequest[];
}

export interface NativeTimelinePlannedSplit {
  readonly address: NativeProjectClipAddress;
  readonly sourceFile: string;
  readonly leftBinding: Readonly<NativeClipDomBinding>;
  readonly rightBinding: Readonly<NativeClipDomBinding>;
  readonly splitFrame: number;
  readonly compatibilitySplitSeconds: number;
  readonly compatibilitySplitTime: string;
}

export type NativeTimelineSplitPlanFailureCode =
  | "empty-split-set"
  | "invalid-split-time"
  | "ambiguous-local-time"
  | "missing-selection-id"
  | "clip-not-found"
  | "ambiguous-clip"
  | "duplicate-clip"
  | "unbound-clip"
  | "binding-source-mismatch"
  | "right-binding-source-mismatch"
  | "native-command-rejected";

export type NativeTimelineSplitPlanResult =
  | {
      readonly ok: true;
      readonly document: NativeProjectDocument;
      readonly splits: readonly NativeTimelinePlannedSplit[];
      readonly sourceFiles: readonly string[];
    }
  | {
      readonly ok: false;
      readonly failure: {
        readonly code: NativeTimelineSplitPlanFailureCode;
        readonly message: string;
        readonly splitIndex?: number;
        readonly nativeCode?: NativeProjectClipFailureCode;
      };
    };

const fail = (
  code: NativeTimelineSplitPlanFailureCode,
  message: string,
  splitIndex?: number,
  nativeCode?: NativeProjectClipFailureCode,
): NativeTimelineSplitPlanResult => ({
  ok: false,
  failure: {
    code,
    message,
    ...(splitIndex === undefined ? {} : { splitIndex }),
    ...(nativeCode ? { nativeCode } : {}),
  },
});

const addressKey = (address: NativeProjectClipAddress): string =>
  JSON.stringify([address.sequenceId, address.trackId, address.clipId]);

const isLocalTimeAmbiguous = (element: NativeTimelineSplitElement): boolean =>
  element.expandedParentStart !== undefined ||
  Boolean(element.expandedHostKey) ||
  Boolean(element.parentCompositionId);

/**
 * Plan a single or batch split against one immutable native snapshot. The
 * project frame is canonical. Decimal seconds and DOM bindings are emitted
 * solely for the transitional compatibility mirror.
 */
export function planNativeTimelineSplits(
  input: NativeTimelineSplitPlanInput,
): NativeTimelineSplitPlanResult {
  if (input.splits.length === 0) {
    return fail("empty-split-set", "A native timeline split requires at least one clip");
  }

  const planned: NativeTimelinePlannedSplit[] = [];
  const addressed = new Set<string>();

  for (const [splitIndex, split] of input.splits.entries()) {
    if (
      !Number.isFinite(split.requestedSplitSeconds) ||
      split.requestedSplitSeconds < 0
    ) {
      return fail(
        "invalid-split-time",
        "Native split time must be finite and non-negative",
        splitIndex,
      );
    }
    if (isLocalTimeAmbiguous(split.element)) {
      return fail(
        "ambiguous-local-time",
        "Expanded or nested compatibility rows cannot define a native project split boundary",
        splitIndex,
      );
    }

    const resolution = resolveNativeClipSelection(input.document, split.element);
    if (!resolution.ok) {
      const code = resolution.failure.code;
      if (code === "missing-selection-id" || code === "clip-not-found" || code === "ambiguous-clip") {
        return fail(code, resolution.failure.message, splitIndex);
      }
      return fail("clip-not-found", resolution.failure.message, splitIndex);
    }

    const { clip, trackId } = resolution.located;
    const leftBinding = clip.binding;
    if (!leftBinding) {
      return fail(
        "unbound-clip",
        `Native clip ${clip.id} has no compatibility binding`,
        splitIndex,
      );
    }
    if (
      typeof split.element.sourceFile !== "string" ||
      split.element.sourceFile.length === 0 ||
      split.element.sourceFile !== leftBinding.sourceFile
    ) {
      return fail(
        "binding-source-mismatch",
        `Selected source does not exactly match native binding ${leftBinding.sourceFile}`,
        splitIndex,
      );
    }
    if (split.rightBinding.sourceFile !== leftBinding.sourceFile) {
      return fail(
        "right-binding-source-mismatch",
        "The compatibility split must create its right clip in the same source file",
        splitIndex,
      );
    }

    const address: NativeProjectClipAddress = {
      sequenceId: input.document.sequence.id,
      trackId,
      clipId: clip.id,
    };
    const key = addressKey(address);
    if (addressed.has(key)) {
      return fail(
        "duplicate-clip",
        `Native clip ${clip.id} is targeted more than once by the same split operation`,
        splitIndex,
      );
    }
    addressed.add(key);

    let splitFrame: number;
    try {
      splitFrame = projectFrameFromSeconds(
        split.requestedSplitSeconds,
        input.document.frameRate,
      );
    } catch (error) {
      return fail(
        "invalid-split-time",
        error instanceof Error ? error.message : "Invalid native split time",
        splitIndex,
      );
    }
    if (!Number.isSafeInteger(splitFrame)) {
      return fail(
        "invalid-split-time",
        "Native split time must resolve to a safe project frame",
        splitIndex,
      );
    }
    const compatibilitySplitSeconds =
      (splitFrame * input.document.frameRate.denominator) /
      input.document.frameRate.numerator;
    planned.push({
      address,
      sourceFile: leftBinding.sourceFile,
      leftBinding: { ...leftBinding },
      rightBinding: { ...split.rightBinding },
      splitFrame,
      compatibilitySplitSeconds,
      compatibilitySplitTime: String(compatibilitySplitSeconds),
    });
  }

  let document = input.document;
  for (const [splitIndex, split] of planned.entries()) {
    const command = applyNativeProjectClipCommand(document, {
      type: "split",
      address: split.address,
      splitFrame: split.splitFrame,
      rightBinding: { ...split.rightBinding },
    });
    if (!command.ok) {
      return fail(
        "native-command-rejected",
        command.failure.message,
        splitIndex,
        command.failure.code,
      );
    }
    document = command.document;
  }

  return {
    ok: true,
    document,
    splits: planned,
    sourceFiles: [...new Set(planned.map((split) => split.sourceFile))].sort(),
  };
}

export function planNativeTimelineSplit(
  input: Omit<NativeTimelineSplitPlanInput, "splits"> & { readonly split: NativeTimelineSplitRequest },
): NativeTimelineSplitPlanResult {
  return planNativeTimelineSplits({ document: input.document, splits: [input.split] });
}
