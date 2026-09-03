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
  planNativeTimelineMultiMove,
  type NativeTimelineMultiMoveChange,
  type NativeTimelineMultiMoveDestination,
  type NativeTimelineMultiMovePlanFailureCode,
  type NativeTimelineMultiMovePlannedMove,
} from "./nativeTimelineMultiMovePlan";
import {
  commitNativeTimelineFileSnapshots,
  type CommitNativeTimelineFileTransaction,
} from "./nativeTimelineTransactionCommit";

type ProjectFileWriter = (path: string, content: string, expectedContent?: string) => Promise<void>;

export interface NativeTimelineMultiMoveCompatibilityEdit {
  readonly address: NativeTimelineMultiMovePlannedMove["address"];
  readonly binding: Readonly<NativeClipDomBinding>;
  readonly exactStartSeconds: number;
  readonly destination: NativeTimelineMultiMoveDestination;
}

export interface CommitNativeTimelineMultiMoveInput {
  readonly expectedRevision: number;
  readonly changes: readonly NativeTimelineMultiMoveChange[];
  readonly readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  readonly writeProjectFile: ProjectFileWriter;
  readonly recordEdit: (input: RecordEditInput) => Promise<void>;
  readonly commitFileTransaction?: CommitNativeTimelineFileTransaction;
  readonly patchCompatibilityContent: (
    content: string,
    edit: NativeTimelineMultiMoveCompatibilityEdit,
    sourceFile: string,
  ) => string;
  readonly onCommitted?: (document: NativeProjectDocument) => void;
  readonly signal?: AbortSignal;
  readonly coalesceKey?: string;
  readonly coalesceMs?: number;
}

export type CommitNativeTimelineMultiMoveResult =
  | {
      readonly committed: true;
      readonly document: NativeProjectDocument;
      readonly nativeContent: string;
      readonly compatibilityContents: Readonly<Record<string, string>>;
      readonly moves: readonly NativeTimelineMultiMovePlannedMove[];
    }
  | {
      readonly committed: false;
      readonly reason:
        | NativeTimelineMultiMovePlanFailureCode
        | "missing-native-project"
        | "missing-compatibility-file";
      readonly sourceFile?: string;
    };

export class NativeTimelineMultiMoveCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeTimelineMultiMoveCompatibilityError";
  }
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The native multi-clip move was aborted", "AbortError");
};

const sourcePathsFromChanges = (
  changes: readonly NativeTimelineMultiMoveChange[],
): string[] | null => {
  const paths: string[] = [];
  for (const change of changes) {
    const path = change.element.sourceFile;
    if (typeof path !== "string" || path.length === 0) return null;
    paths.push(path);
  }
  return [...new Set(paths)].sort();
};

const plannedMoveKey = (move: NativeTimelineMultiMovePlannedMove): string =>
  JSON.stringify([move.sourceFile, move.address.sequenceId, move.address.trackId, move.address.clipId]);

/**
 * Persist a native group move and every transitional compatibility source as
 * one CAS-protected editor transaction. Publication follows durable writes and
 * the single history entry; any ordinary failure rolls back in reverse order.
 */
export async function commitNativeTimelineMultiMove(
  input: CommitNativeTimelineMultiMoveInput,
): Promise<CommitNativeTimelineMultiMoveResult> {
  throwIfAborted(input.signal);
  const requestedSourcePaths = sourcePathsFromChanges(input.changes);
  if (!requestedSourcePaths) {
    return { committed: false, reason: "unbound-clip" };
  }

  const result = await serializeStudioFileMutations(
    input.writeProjectFile,
    [NATIVE_PROJECT_DOCUMENT_PATH, ...requestedSourcePaths],
    async (): Promise<CommitNativeTimelineMultiMoveResult> => {
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

      const plan = planNativeTimelineMultiMove({ document: current, changes: input.changes });
      if (!plan.ok) return { committed: false, reason: plan.failure.code };
      if (
        plan.sourceFiles.length !== requestedSourcePaths.length ||
        plan.sourceFiles.some((path, index) => path !== requestedSourcePaths[index])
      ) {
        throw new NativeTimelineMultiMoveCompatibilityError(
          "Resolved native clip sources do not match the compatibility files locked for the gesture",
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
      const orderedMoves = [...plan.moves].sort((left, right) =>
        plannedMoveKey(left).localeCompare(plannedMoveKey(right)),
      );
      for (const move of orderedMoves) {
        throwIfAborted(input.signal);
        const beforePatch = compatibilityAfter[move.sourceFile]!;
        const afterPatch = input.patchCompatibilityContent(
          beforePatch,
          {
            address: move.address,
            binding: move.binding,
            exactStartSeconds: move.compatibilityStartSeconds,
            destination: move.destination,
          },
          move.sourceFile,
        );
        if (afterPatch === beforePatch) {
          throw new NativeTimelineMultiMoveCompatibilityError(
            `Compatibility source ${move.sourceFile} did not accept the patch for native clip ${move.address.clipId}`,
          );
        }
        compatibilityAfter[move.sourceFile] = afterPatch;
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
          label: "Move timeline clips",
          kind: "timeline",
          coalesceKey:
            input.coalesceKey ??
            `timeline-move-many:${[...plan.moves]
              .map((move) => move.address.clipId)
              .sort()
              .join(",")}`,
          ...(input.coalesceMs == null ? {} : { coalesceMs: input.coalesceMs }),
        },
        commitFileTransaction: input.commitFileTransaction,
        writeProjectFile: input.writeProjectFile,
        recordEdit: input.recordEdit,
        rollbackFailureMessage: "Native multi-clip move failed and rollback did not complete",
        signal: input.signal,
      });

      return {
        committed: true,
        document,
        nativeContent: nativeAfter,
        compatibilityContents: compatibilityAfter,
        moves: plan.moves,
      };
    },
  );

  if (result.committed) input.onCommitted?.(result.document);
  return result;
}
