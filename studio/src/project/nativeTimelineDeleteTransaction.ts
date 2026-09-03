import { furthestClipEndFromSource } from "../player/lib/timelineElementHelpers";
import { setCompositionDurationToContent } from "../utils/timelineAssetDrop";
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
  planNativeTimelineDelete,
  type NativeTimelineDeletePlanFailureCode,
  type NativeTimelineDeletePlannedTarget,
  type NativeTimelineDeleteTarget,
} from "./nativeTimelineDeletePlan";
import {
  commitNativeTimelineFileSnapshots,
  type CommitNativeTimelineFileTransaction,
} from "./nativeTimelineTransactionCommit";

type ProjectFileWriter = (path: string, content: string, expectedContent?: string) => Promise<void>;

export interface NativeTimelineDeleteCompatibilityEdit {
  readonly address: NativeTimelineDeletePlannedTarget["address"];
  readonly binding: Readonly<NativeClipDomBinding>;
}

export interface CommitNativeTimelineDeleteInput {
  readonly expectedRevision: number;
  readonly targets: readonly NativeTimelineDeleteTarget[];
  readonly readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  readonly writeProjectFile: ProjectFileWriter;
  readonly recordEdit: (input: RecordEditInput) => Promise<void>;
  readonly commitFileTransaction?: CommitNativeTimelineFileTransaction;
  /** Remove exactly one binding and return the accumulated source content. */
  readonly removeCompatibilityTarget: (
    content: string,
    edit: NativeTimelineDeleteCompatibilityEdit,
    sourceFile: string,
  ) => string;
  readonly onCommitted?: (document: NativeProjectDocument) => void;
  readonly signal?: AbortSignal;
}

export type CommitNativeTimelineDeleteResult =
  | {
      readonly committed: true;
      readonly document: NativeProjectDocument;
      readonly nativeContent: string;
      readonly compatibilityContents: Readonly<Record<string, string>>;
      readonly deletions: readonly NativeTimelineDeletePlannedTarget[];
    }
  | {
      readonly committed: false;
      readonly reason:
        | NativeTimelineDeletePlanFailureCode
        | "missing-native-project"
        | "missing-compatibility-file";
      readonly sourceFile?: string;
    };

export class NativeTimelineDeleteCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeTimelineDeleteCompatibilityError";
  }
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The native timeline delete was aborted", "AbortError");
};

const requestedSourcePaths = (
  targets: readonly NativeTimelineDeleteTarget[],
): string[] | null => {
  const paths: string[] = [];
  for (const target of targets) {
    const path = target.sourceFile;
    if (typeof path !== "string" || path.length === 0) return null;
    paths.push(path);
  }
  return [...new Set(paths)].sort();
};

const plannedTargetKey = (target: NativeTimelineDeletePlannedTarget): string =>
  JSON.stringify([
    target.sourceFile,
    target.address.sequenceId,
    target.address.trackId,
    target.address.clipId,
  ]);

/**
 * Persist one native single- or multi-clip delete and every compatibility
 * mirror as an all-or-nothing editor operation. All targets are planned once,
 * files are locked and written deterministically, and publication happens only
 * after the one history entry is durable.
 */
export async function commitNativeTimelineDelete(
  input: CommitNativeTimelineDeleteInput,
): Promise<CommitNativeTimelineDeleteResult> {
  throwIfAborted(input.signal);
  const lockedSources = requestedSourcePaths(input.targets);
  if (!lockedSources) return { committed: false, reason: "unbound-clip" };

  const result = await serializeStudioFileMutations(
    input.writeProjectFile,
    [NATIVE_PROJECT_DOCUMENT_PATH, ...lockedSources],
    async (): Promise<CommitNativeTimelineDeleteResult> => {
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

      const plan = planNativeTimelineDelete({ document: current, targets: input.targets });
      if (!plan.ok) return { committed: false, reason: plan.failure.code };
      if (
        plan.sourceFiles.length !== lockedSources.length ||
        plan.sourceFiles.some((sourceFile, index) => sourceFile !== lockedSources[index])
      ) {
        throw new NativeTimelineDeleteCompatibilityError(
          "Resolved native clip sources do not match the compatibility files locked for deletion",
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

      const accumulated: Record<string, string> = { ...compatibilityBefore };
      for (const deletion of [...plan.deletions].sort((left, right) =>
        plannedTargetKey(left).localeCompare(plannedTargetKey(right)),
      )) {
        throwIfAborted(input.signal);
        const beforeRemoval = accumulated[deletion.sourceFile]!;
        const afterRemoval = input.removeCompatibilityTarget(
          beforeRemoval,
          { address: deletion.address, binding: deletion.binding },
          deletion.sourceFile,
        );
        if (afterRemoval === beforeRemoval) {
          throw new NativeTimelineDeleteCompatibilityError(
            `Compatibility source ${deletion.sourceFile} did not match native clip ${deletion.address.clipId}`,
          );
        }
        accumulated[deletion.sourceFile] = afterRemoval;
      }

      const compatibilityAfter: Record<string, string> = {};
      for (const sourceFile of plan.sourceFiles) {
        const removedContent = accumulated[sourceFile]!;
        compatibilityAfter[sourceFile] = setCompositionDurationToContent(
          removedContent,
          furthestClipEndFromSource(removedContent),
        );
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
          label: plan.deletions.length === 1 ? "Delete timeline clip" : "Delete timeline clips",
          kind: "timeline",
        },
        commitFileTransaction: input.commitFileTransaction,
        writeProjectFile: input.writeProjectFile,
        recordEdit: input.recordEdit,
        rollbackFailureMessage: "Native timeline delete failed and rollback did not complete",
        signal: input.signal,
      });

      return {
        committed: true,
        document,
        nativeContent: nativeAfter,
        compatibilityContents: compatibilityAfter,
        deletions: plan.deletions,
      };
    },
  );

  if (result.committed) input.onCommitted?.(result.document);
  return result;
}
