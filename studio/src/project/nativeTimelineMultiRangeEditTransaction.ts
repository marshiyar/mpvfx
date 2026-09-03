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
  planNativeTimelineMultiRangeEdit,
  type NativeTimelineMultiRangeEditChange,
  type NativeTimelineMultiRangeEditPlanFailureCode,
  type NativeTimelineMultiRangePlannedEdit,
} from "./nativeTimelineMultiRangeEditPlan";
import type {
  NativeTimelineCompatibilityRange,
  NativeTimelineRangeEditKind,
} from "./nativeTimelineRangeEditPlan";
import {
  commitNativeTimelineFileSnapshots,
  type CommitNativeTimelineFileTransaction,
} from "./nativeTimelineTransactionCommit";

type ProjectFileWriter = (path: string, content: string, expectedContent?: string) => Promise<void>;

export interface NativeTimelineMultiRangeCompatibilityEdit {
  readonly address: NativeTimelineMultiRangePlannedEdit["address"];
  readonly binding: Readonly<NativeClipDomBinding>;
  readonly kind: NativeTimelineRangeEditKind;
  readonly timing: NativeTimelineCompatibilityRange;
}

export interface CommitNativeTimelineMultiRangeEditInput {
  readonly expectedRevision: number;
  readonly changes: readonly NativeTimelineMultiRangeEditChange[];
  readonly readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  readonly writeProjectFile: ProjectFileWriter;
  readonly recordEdit: (input: RecordEditInput) => Promise<void>;
  readonly commitFileTransaction?: CommitNativeTimelineFileTransaction;
  readonly patchCompatibilityContent: (
    content: string,
    edit: NativeTimelineMultiRangeCompatibilityEdit,
    sourceFile: string,
  ) => string;
  readonly onCommitted?: (document: NativeProjectDocument) => void;
  readonly signal?: AbortSignal;
  readonly coalesceKey?: string;
  readonly coalesceMs?: number;
}

export type CommitNativeTimelineMultiRangeEditResult =
  | {
      readonly committed: true;
      readonly document: NativeProjectDocument;
      readonly nativeContent: string;
      readonly compatibilityContents: Readonly<Record<string, string>>;
      readonly edits: readonly NativeTimelineMultiRangePlannedEdit[];
    }
  | {
      readonly committed: false;
      readonly reason:
        | NativeTimelineMultiRangeEditPlanFailureCode
        | "missing-native-project"
        | "missing-compatibility-file";
      readonly sourceFile?: string;
    };

export class NativeTimelineMultiRangeCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeTimelineMultiRangeCompatibilityError";
  }
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The native multi-clip range edit was aborted", "AbortError");
};

const sourcePathsFromChanges = (
  changes: readonly NativeTimelineMultiRangeEditChange[],
): string[] | null => {
  const paths: string[] = [];
  for (const change of changes) {
    const path = change.element.sourceFile;
    if (typeof path !== "string" || path.length === 0) return null;
    paths.push(path);
  }
  return [...new Set(paths)].sort();
};

const plannedEditKey = (edit: NativeTimelineMultiRangePlannedEdit): string =>
  JSON.stringify([edit.sourceFile, edit.address.sequenceId, edit.address.trackId, edit.address.clipId]);

/**
 * Persist one native-canonical multi-selection trim and all compatibility
 * mirrors under shared file locks. The project revision advances once, history
 * is recorded once, and publication occurs only after every CAS write is
 * durable. Any write, cancellation, or history failure rolls back in reverse.
 */
export async function commitNativeTimelineMultiRangeEdit(
  input: CommitNativeTimelineMultiRangeEditInput,
): Promise<CommitNativeTimelineMultiRangeEditResult> {
  throwIfAborted(input.signal);
  const requestedSourcePaths = sourcePathsFromChanges(input.changes);
  if (!requestedSourcePaths) {
    return { committed: false, reason: "unbound-clip" };
  }

  const result = await serializeStudioFileMutations(
    input.writeProjectFile,
    [NATIVE_PROJECT_DOCUMENT_PATH, ...requestedSourcePaths],
    async (): Promise<CommitNativeTimelineMultiRangeEditResult> => {
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

      const plan = planNativeTimelineMultiRangeEdit({ document: current, changes: input.changes });
      if (!plan.ok) return { committed: false, reason: plan.failure.code };
      if (
        plan.sourceFiles.length !== requestedSourcePaths.length ||
        plan.sourceFiles.some((path, index) => path !== requestedSourcePaths[index])
      ) {
        throw new NativeTimelineMultiRangeCompatibilityError(
          "Resolved native clip sources do not match the compatibility files locked for the range edit",
        );
      }

      const compatibilityBefore: Record<string, string> = {};
      for (const sourceFile of plan.sourceFiles) {
        throwIfAborted(input.signal);
        const content = await input.readOptionalProjectFile(sourceFile);
        throwIfAborted(input.signal);
        if (content == null) {
          return { committed: false, reason: "missing-compatibility-file", sourceFile };
        }
        compatibilityBefore[sourceFile] = content;
      }

      const compatibilityAfter: Record<string, string> = { ...compatibilityBefore };
      const orderedEdits = [...plan.edits].sort((left, right) =>
        plannedEditKey(left).localeCompare(plannedEditKey(right)),
      );
      for (const edit of orderedEdits) {
        throwIfAborted(input.signal);
        const beforePatch = compatibilityAfter[edit.sourceFile]!;
        const afterPatch = input.patchCompatibilityContent(
          beforePatch,
          {
            address: edit.address,
            binding: edit.binding,
            kind: edit.kind,
            timing: edit.compatibility,
          },
          edit.sourceFile,
        );
        if (afterPatch === beforePatch) {
          throw new NativeTimelineMultiRangeCompatibilityError(
            `Compatibility source ${edit.sourceFile} did not accept the range patch for native clip ${edit.address.clipId}`,
          );
        }
        compatibilityAfter[edit.sourceFile] = afterPatch;
      }

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
      await commitNativeTimelineFileSnapshots({
        orderedPaths,
        snapshots,
        history: {
          label: "Trim timeline clips",
          kind: "timeline",
          coalesceKey:
            input.coalesceKey ??
            `timeline-resize-many:${[...plan.edits]
              .map((edit) => edit.address.clipId)
              .sort()
              .join(",")}`,
          ...(input.coalesceMs == null ? {} : { coalesceMs: input.coalesceMs }),
        },
        commitFileTransaction: input.commitFileTransaction,
        writeProjectFile: input.writeProjectFile,
        recordEdit: input.recordEdit,
        rollbackFailureMessage: "Native multi-clip range edit failed and rollback did not complete",
        signal: input.signal,
      });

      return {
        committed: true,
        document,
        nativeContent: nativeAfter,
        compatibilityContents: compatibilityAfter,
        edits: plan.edits,
      };
    },
  );

  if (result.committed) input.onCommitted?.(result.document);
  return result;
}
