import type { RecordEditInput } from "../utils/studioFileHistory";
import { serializeStudioFileMutations } from "../utils/studioFileMutationCoordinator";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeClipDomBinding,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import {
  planNativeTimelineSplits,
  type NativeTimelinePlannedSplit,
  type NativeTimelineSplitElement,
  type NativeTimelineSplitPlanFailureCode,
} from "./nativeTimelineSplitPlan";
import {
  projectFrameFromSeconds,
  resolveNativeClipSelection,
} from "./nativePropertyEditPlan";
import {
  commitNativeTimelineFileSnapshots,
  type CommitNativeTimelineFileTransaction,
} from "./nativeTimelineTransactionCommit";

type ProjectFileWriter = (path: string, content: string, expectedContent?: string) => Promise<void>;

export interface NativeTimelineSplitChange {
  readonly element: NativeTimelineSplitElement;
  readonly requestedSplitSeconds: number;
}

export interface NativeTimelineSplitCompatibilityEdit {
  readonly requestIndex: number;
  readonly sourceFile: string;
  readonly leftBinding: Readonly<NativeClipDomBinding>;
  readonly splitFrame: number;
  readonly compatibilitySplitSeconds: number;
  readonly compatibilitySplitTime: string;
}

export interface NativeTimelineSplitCompatibilityResult {
  readonly content: string;
  /** The exact identity actually created by the compatibility transform. */
  readonly rightBinding: Readonly<NativeClipDomBinding>;
}

export interface CommitNativeTimelineSplitsInput {
  readonly expectedRevision: number;
  readonly splits: readonly NativeTimelineSplitChange[];
  readonly readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  readonly writeProjectFile: ProjectFileWriter;
  readonly recordEdit: (input: RecordEditInput) => Promise<void>;
  readonly commitFileTransaction?: CommitNativeTimelineFileTransaction;
  readonly patchCompatibilityContent: (
    content: string,
    edit: NativeTimelineSplitCompatibilityEdit,
    sourceFile: string,
  ) => NativeTimelineSplitCompatibilityResult;
  readonly onCommitted?: (document: NativeProjectDocument) => void;
  readonly signal?: AbortSignal;
}

export type CommitNativeTimelineSplitsResult =
  | {
      readonly committed: true;
      readonly document: NativeProjectDocument;
      readonly nativeContent: string;
      readonly compatibilityContents: Readonly<Record<string, string>>;
      readonly splits: readonly NativeTimelinePlannedSplit[];
    }
  | {
      readonly committed: false;
      readonly reason:
        | NativeTimelineSplitPlanFailureCode
        | "missing-native-project"
        | "missing-compatibility-file";
      readonly sourceFile?: string;
    };

export class NativeTimelineSplitCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeTimelineSplitCompatibilityError";
  }
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The native timeline split was aborted", "AbortError");
};

const requestedSourcePaths = (
  splits: readonly NativeTimelineSplitChange[],
): string[] | null => {
  const paths: string[] = [];
  for (const split of splits) {
    if (typeof split.element.sourceFile !== "string" || split.element.sourceFile.length === 0) {
      return null;
    }
    paths.push(split.element.sourceFile);
  }
  return [...new Set(paths)].sort();
};

type PreparedCompatibilityEdit = NativeTimelineSplitCompatibilityEdit & {
  readonly addressKey: string;
};

type PreparedResult =
  | { readonly ok: true; readonly edits: readonly PreparedCompatibilityEdit[] }
  | { readonly ok: false; readonly reason: NativeTimelineSplitPlanFailureCode };

const prepareCompatibilityEdits = (
  document: NativeProjectDocument,
  splits: readonly NativeTimelineSplitChange[],
): PreparedResult => {
  if (splits.length === 0) return { ok: false, reason: "empty-split-set" };
  const addressed = new Set<string>();
  const edits: PreparedCompatibilityEdit[] = [];

  for (const [requestIndex, split] of splits.entries()) {
    if (!Number.isFinite(split.requestedSplitSeconds) || split.requestedSplitSeconds < 0) {
      return { ok: false, reason: "invalid-split-time" };
    }
    if (
      split.element.expandedParentStart !== undefined ||
      split.element.expandedHostKey ||
      split.element.parentCompositionId
    ) {
      return { ok: false, reason: "ambiguous-local-time" };
    }
    const resolution = resolveNativeClipSelection(document, split.element);
    if (!resolution.ok) {
      const code = resolution.failure.code;
      return {
        ok: false,
        reason:
          code === "missing-selection-id" || code === "clip-not-found" || code === "ambiguous-clip"
            ? code
            : "clip-not-found",
      };
    }
    const { clip, trackId } = resolution.located;
    if (!clip.binding) return { ok: false, reason: "unbound-clip" };
    if (clip.binding.sourceFile !== split.element.sourceFile) {
      return { ok: false, reason: "binding-source-mismatch" };
    }
    const addressKey = JSON.stringify([document.sequence.id, trackId, clip.id]);
    if (addressed.has(addressKey)) return { ok: false, reason: "duplicate-clip" };
    addressed.add(addressKey);

    let splitFrame: number;
    try {
      splitFrame = projectFrameFromSeconds(split.requestedSplitSeconds, document.frameRate);
    } catch {
      return { ok: false, reason: "invalid-split-time" };
    }
    const localFrame = splitFrame - clip.startFrame;
    const rate = clip.playbackRate ?? { numerator: 1, denominator: 1 };
    if (
      !Number.isSafeInteger(splitFrame) ||
      localFrame <= 0 ||
      localFrame >= clip.durationFrames ||
      (BigInt(localFrame) * BigInt(rate.numerator)) % BigInt(rate.denominator) !== 0n
    ) {
      return { ok: false, reason: "native-command-rejected" };
    }
    const compatibilitySplitSeconds =
      (splitFrame * document.frameRate.denominator) / document.frameRate.numerator;
    edits.push({
      requestIndex,
      sourceFile: clip.binding.sourceFile,
      leftBinding: { ...clip.binding },
      splitFrame,
      compatibilitySplitSeconds,
      compatibilitySplitTime: String(compatibilitySplitSeconds),
      addressKey,
    });
  }
  return { ok: true, edits };
};

const hasUsableBindingIdentity = (binding: Readonly<NativeClipDomBinding>): boolean =>
  Boolean(binding.domId || binding.hfId || binding.selector);

/**
 * Persist a single or batch native split and every affected compatibility file
 * as one CAS-protected operation. Compatibility transforms run fully in memory
 * first and must return the right-hand identity they actually created.
 */
export async function commitNativeTimelineSplits(
  input: CommitNativeTimelineSplitsInput,
): Promise<CommitNativeTimelineSplitsResult> {
  throwIfAborted(input.signal);
  const sourcePaths = requestedSourcePaths(input.splits);
  if (!sourcePaths) return { committed: false, reason: "binding-source-mismatch" };

  const result = await serializeStudioFileMutations(
    input.writeProjectFile,
    [NATIVE_PROJECT_DOCUMENT_PATH, ...sourcePaths],
    async (): Promise<CommitNativeTimelineSplitsResult> => {
      throwIfAborted(input.signal);
      const nativeBefore = await input.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
      throwIfAborted(input.signal);
      if (nativeBefore == null || nativeBefore.trim().length === 0) {
        return { committed: false, reason: "missing-native-project" };
      }
      const current = parseNativeProjectDocument(JSON.parse(nativeBefore));
      if (current.revision !== input.expectedRevision) {
        throw new NativeProjectRevisionConflictError(input.expectedRevision, current.revision);
      }

      const prepared = prepareCompatibilityEdits(current, input.splits);
      if (!prepared.ok) return { committed: false, reason: prepared.reason };
      const resolvedSourcePaths = [...new Set(prepared.edits.map((edit) => edit.sourceFile))].sort();
      if (
        sourcePaths.length !== resolvedSourcePaths.length ||
        sourcePaths.some((path, index) => path !== resolvedSourcePaths[index])
      ) {
        return { committed: false, reason: "binding-source-mismatch" };
      }

      const compatibilityBefore: Record<string, string> = {};
      for (const sourceFile of sourcePaths) {
        throwIfAborted(input.signal);
        const content = await input.readOptionalProjectFile(sourceFile);
        throwIfAborted(input.signal);
        if (content == null) {
          return { committed: false, reason: "missing-compatibility-file", sourceFile };
        }
        compatibilityBefore[sourceFile] = content;
      }

      const compatibilityAfter: Record<string, string> = { ...compatibilityBefore };
      const bindingsByRequest = new Map<number, Readonly<NativeClipDomBinding>>();
      const orderedEdits = [...prepared.edits].sort((left, right) =>
        left.sourceFile.localeCompare(right.sourceFile) || left.addressKey.localeCompare(right.addressKey),
      );
      for (const edit of orderedEdits) {
        throwIfAborted(input.signal);
        const beforePatch = compatibilityAfter[edit.sourceFile]!;
        const patched = input.patchCompatibilityContent(beforePatch, edit, edit.sourceFile);
        if (
          !patched ||
          typeof patched.content !== "string" ||
          patched.content === beforePatch ||
          !patched.rightBinding ||
          patched.rightBinding.sourceFile !== edit.sourceFile ||
          !hasUsableBindingIdentity(patched.rightBinding)
        ) {
          throw new NativeTimelineSplitCompatibilityError(
            `Compatibility source ${edit.sourceFile} did not return a changed document and exact right-clip identity`,
          );
        }
        compatibilityAfter[edit.sourceFile] = patched.content;
        bindingsByRequest.set(edit.requestIndex, { ...patched.rightBinding });
      }

      const plan = planNativeTimelineSplits({
        document: current,
        splits: input.splits.map((split, requestIndex) => ({
          ...split,
          rightBinding: bindingsByRequest.get(requestIndex)!,
        })),
      });
      if (!plan.ok) return { committed: false, reason: plan.failure.code };

      const document = parseNativeProjectDocument({
        ...plan.document,
        revision: current.revision + 1,
      });
      const nativeAfter = serializeNativeProjectDocument(document);
      const snapshots: Record<string, { before: string; after: string }> = {
        [NATIVE_PROJECT_DOCUMENT_PATH]: { before: nativeBefore, after: nativeAfter },
      };
      for (const sourceFile of plan.sourceFiles) {
        snapshots[sourceFile] = {
          before: compatibilityBefore[sourceFile]!,
          after: compatibilityAfter[sourceFile]!,
        };
      }

      const orderedPaths = [NATIVE_PROJECT_DOCUMENT_PATH, ...plan.sourceFiles];
      const clipIds = [...plan.splits.map((split) => split.address.clipId)].sort();
      await commitNativeTimelineFileSnapshots({
        orderedPaths,
        snapshots,
        history: {
          label: plan.splits.length === 1 ? "Split timeline clip" : "Split timeline clips",
          kind: "timeline",
          coalesceKey: `timeline-split:${clipIds.join(",")}`,
        },
        commitFileTransaction: input.commitFileTransaction,
        writeProjectFile: input.writeProjectFile,
        recordEdit: input.recordEdit,
        rollbackFailureMessage: "Native timeline split failed and rollback did not complete",
        signal: input.signal,
      });

      return {
        committed: true,
        document,
        nativeContent: nativeAfter,
        compatibilityContents: compatibilityAfter,
        splits: plan.splits,
      };
    },
  );

  if (result.committed) input.onCommitted?.(result.document);
  return result;
}

export async function commitNativeTimelineSplit(
  input: Omit<CommitNativeTimelineSplitsInput, "splits"> & { readonly split: NativeTimelineSplitChange },
): Promise<CommitNativeTimelineSplitsResult> {
  return commitNativeTimelineSplits({ ...input, splits: [input.split] });
}
