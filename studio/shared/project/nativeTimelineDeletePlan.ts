import type {
  NativeClipDomBinding,
  NativeProjectDocument,
} from "./nativeProjectDocument";
import {
  applyNativeProjectClipCommand,
  type NativeProjectClipAddress,
} from "./nativeProjectClipCommands";
import {
  resolveNativeClipSelection,
  type NativeSelectedElementReference,
} from "./nativePropertyEditPlan";

export interface NativeTimelineDeleteTarget extends NativeSelectedElementReference {
  readonly structuralRole?: string | null;
}

export interface NativeTimelineDeletePlanInput {
  readonly document: NativeProjectDocument;
  readonly targets: readonly NativeTimelineDeleteTarget[];
}

export interface NativeTimelineDeletePlannedTarget {
  readonly address: NativeProjectClipAddress;
  readonly sourceFile: string;
  readonly binding: Readonly<NativeClipDomBinding>;
}

export type NativeTimelineDeletePlanFailureCode =
  | "empty-target-set"
  | "protected-root"
  | "missing-selection-id"
  | "clip-not-found"
  | "ambiguous-clip"
  | "duplicate-clip"
  | "unbound-clip"
  | "binding-source-mismatch"
  | "native-command-rejected";

export type NativeTimelineDeletePlanResult =
  | {
      readonly ok: true;
      readonly document: NativeProjectDocument;
      readonly deletions: readonly NativeTimelineDeletePlannedTarget[];
      readonly sourceFiles: readonly string[];
    }
  | {
      readonly ok: false;
      readonly failure: {
        readonly code: NativeTimelineDeletePlanFailureCode;
        readonly message: string;
        readonly targetIndex?: number;
      };
    };

const fail = (
  code: NativeTimelineDeletePlanFailureCode,
  message: string,
  targetIndex?: number,
): NativeTimelineDeletePlanResult => ({
  ok: false,
  failure: {
    code,
    message,
    ...(targetIndex === undefined ? {} : { targetIndex }),
  },
});

const addressKey = (address: NativeProjectClipAddress): string =>
  JSON.stringify([address.sequenceId, address.trackId, address.clipId]);

const isCompositionRootTarget = (target: NativeTimelineDeleteTarget): boolean => {
  if (target.structuralRole === "composition-root") return true;
  if (target.attributes?.["data-composition-id"] != null) return true;
  return typeof target.selector === "string" && /\[\s*data-composition-id(?:\s*[=\]])/i.test(target.selector);
};

/**
 * Validate an entire delete selection against one immutable native snapshot,
 * then remove every clip in one native command. Compatibility identities are
 * output only; durable native clip IDs remain the canonical addresses.
 */
export function planNativeTimelineDelete(
  input: NativeTimelineDeletePlanInput,
): NativeTimelineDeletePlanResult {
  if (input.targets.length === 0) {
    return fail("empty-target-set", "A native timeline delete requires at least one target");
  }

  const deletions: NativeTimelineDeletePlannedTarget[] = [];
  const addressed = new Set<string>();

  for (const [targetIndex, target] of input.targets.entries()) {
    if (isCompositionRootTarget(target)) {
      return fail(
        "protected-root",
        "The composition root is structural and cannot be deleted",
        targetIndex,
      );
    }

    const resolution = resolveNativeClipSelection(input.document, target);
    if (!resolution.ok) {
      const code = resolution.failure.code;
      if (code === "missing-selection-id" || code === "clip-not-found" || code === "ambiguous-clip") {
        return fail(code, resolution.failure.message, targetIndex);
      }
      return fail("clip-not-found", resolution.failure.message, targetIndex);
    }

    const { clip, trackId } = resolution.located;
    if (!clip.binding) {
      return fail(
        "unbound-clip",
        `Native clip ${clip.id} has no compatibility source binding`,
        targetIndex,
      );
    }
    if (
      typeof target.sourceFile === "string" &&
      target.sourceFile.length > 0 &&
      target.sourceFile !== clip.binding.sourceFile
    ) {
      return fail(
        "binding-source-mismatch",
        `Selected source ${target.sourceFile} does not match native binding ${clip.binding.sourceFile}`,
        targetIndex,
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
        `Native clip ${clip.id} is targeted more than once by the same delete`,
        targetIndex,
      );
    }
    addressed.add(key);
    deletions.push({
      address,
      sourceFile: clip.binding.sourceFile,
      binding: { ...clip.binding },
    });
  }

  const command = applyNativeProjectClipCommand(input.document, {
    type: "delete-many",
    addresses: deletions.map((deletion) => deletion.address),
  });
  if (!command.ok) {
    return fail("native-command-rejected", command.failure.message);
  }

  return {
    ok: true,
    document: command.document,
    deletions,
    sourceFiles: [...new Set(deletions.map((deletion) => deletion.sourceFile))].sort(),
  };
}
