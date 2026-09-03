import type { RecordEditInput } from "../utils/studioFileHistory";
import { serializeStudioFileMutations } from "../utils/studioFileMutationCoordinator";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeClipDomBinding,
  type NativeProjectAssetKind,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import {
  planNativeTimelineAssetInsertions,
  quantizeNativeTimelineAssetInsertion,
  type NativeTimelineAssetInsertPlanFailureCode,
  type NativeTimelineAssetInsertion,
} from "./nativeTimelineAssetInsertPlan";
import {
  commitNativeTimelineFileSnapshots,
  type CommitNativeTimelineFileTransaction,
} from "./nativeTimelineTransactionCommit";

type ProjectFileWriter = (path: string, content: string, expectedContent?: string) => Promise<void>;

export interface NativeTimelineAssetInsertRequest {
  readonly assetPath: string;
  readonly assetName?: string;
  readonly kind: NativeProjectAssetKind;
  readonly sourceFile: string;
  readonly requestedStartSeconds: number;
  readonly requestedDurationSeconds: number;
  readonly sourceDurationSeconds: number;
  readonly requestedTrack: number;
}

export interface NativeTimelineAssetCompatibilityInsertion extends NativeTimelineAssetInsertRequest {
  readonly insertionIndex: number;
  readonly compatibilityStartSeconds: number;
  readonly compatibilityDurationSeconds: number;
}

export interface NativeTimelineAssetCompatibilityInsertResult {
  readonly content: string;
  readonly binding: Readonly<NativeClipDomBinding>;
}

export interface CommitNativeTimelineAssetInsertionsInput {
  readonly expectedRevision: number;
  readonly insertions: readonly NativeTimelineAssetInsertRequest[];
  readonly readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  readonly writeProjectFile: ProjectFileWriter;
  readonly recordEdit: (input: RecordEditInput) => Promise<void>;
  readonly commitFileTransaction?: CommitNativeTimelineFileTransaction;
  /** Insert one compatibility element and return its actual collision-safe identity. */
  readonly patchCompatibilityContent: (
    content: string,
    insertion: NativeTimelineAssetCompatibilityInsertion,
  ) => NativeTimelineAssetCompatibilityInsertResult;
  readonly onCommitted?: (document: NativeProjectDocument) => void;
  readonly signal?: AbortSignal;
}

export type CommitNativeTimelineAssetInsertionsResult =
  | {
      readonly committed: true;
      readonly document: NativeProjectDocument;
      readonly nativeContent: string;
      readonly compatibilityContents: Readonly<Record<string, string>>;
    }
  | {
      readonly committed: false;
      readonly reason:
        | NativeTimelineAssetInsertPlanFailureCode
        | "missing-native-project"
        | "missing-compatibility-file";
      readonly sourceFile?: string;
    };

export class NativeTimelineAssetInsertCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeTimelineAssetInsertCompatibilityError";
  }
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The native timeline asset insertion was aborted", "AbortError");
};

const lockedSourceFiles = (
  insertions: readonly NativeTimelineAssetInsertRequest[],
): string[] | null => {
  const paths: string[] = [];
  for (const insertion of insertions) {
    if (typeof insertion.sourceFile !== "string" || insertion.sourceFile.trim().length === 0) {
      return null;
    }
    paths.push(insertion.sourceFile);
  }
  return [...new Set(paths)].sort();
};

const requestKey = (request: NativeTimelineAssetInsertRequest): string =>
  JSON.stringify([
    request.sourceFile,
    request.requestedTrack,
    request.requestedStartSeconds,
    request.kind,
    request.assetPath,
    request.requestedDurationSeconds,
    request.sourceDurationSeconds,
  ]);

const hasExactBinding = (binding: Readonly<NativeClipDomBinding>): boolean =>
  typeof binding.sourceFile === "string" &&
  binding.sourceFile.trim().length > 0 &&
  [binding.domId, binding.hfId, binding.selector].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );

/**
 * Commit one or many media insertions as a single native revision and a single
 * history operation. Compatibility markup is accumulated entirely in memory;
 * its actual generated bindings are then validated by the native planner
 * before the first durable write occurs.
 */
export async function commitNativeTimelineAssetInsertions(
  input: CommitNativeTimelineAssetInsertionsInput,
): Promise<CommitNativeTimelineAssetInsertionsResult> {
  throwIfAborted(input.signal);
  const sourceFiles = lockedSourceFiles(input.insertions);
  if (!sourceFiles) return { committed: false, reason: "invalid-source-file" };

  const result = await serializeStudioFileMutations(
    input.writeProjectFile,
    [NATIVE_PROJECT_DOCUMENT_PATH, ...sourceFiles],
    async (): Promise<CommitNativeTimelineAssetInsertionsResult> => {
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

      const timed = input.insertions.map((request, insertionIndex) => ({
        request,
        insertionIndex,
        timing: quantizeNativeTimelineAssetInsertion(current, request),
      }));
      const invalidTiming = timed.find((entry) => !entry.timing.ok);
      if (invalidTiming && !invalidTiming.timing.ok) {
        return { committed: false, reason: invalidTiming.timing.failure.code };
      }

      const compatibilityBefore: Record<string, string> = {};
      for (const sourceFile of sourceFiles) {
        throwIfAborted(input.signal);
        const content = await input.readOptionalProjectFile(sourceFile);
        throwIfAborted(input.signal);
        if (content == null) {
          return { committed: false, reason: "missing-compatibility-file", sourceFile };
        }
        compatibilityBefore[sourceFile] = content;
      }

      const compatibilityAfter: Record<string, string> = { ...compatibilityBefore };
      const plannedInsertions: NativeTimelineAssetInsertion[] = [];
      const ordered = [...timed].sort(
        (left, right) => requestKey(left.request).localeCompare(requestKey(right.request)),
      );
      for (const entry of ordered) {
        throwIfAborted(input.signal);
        if (!entry.timing.ok) continue;
        const beforeInsertion = compatibilityAfter[entry.request.sourceFile]!;
        const patched = input.patchCompatibilityContent(beforeInsertion, {
          ...entry.request,
          insertionIndex: entry.insertionIndex,
          compatibilityStartSeconds: entry.timing.compatibilityStartSeconds,
          compatibilityDurationSeconds: entry.timing.compatibilityDurationSeconds,
        });
        if (patched.content === beforeInsertion) {
          throw new NativeTimelineAssetInsertCompatibilityError(
            `Compatibility source ${entry.request.sourceFile} did not insert ${entry.request.assetPath}`,
          );
        }
        if (!hasExactBinding(patched.binding)) {
          throw new NativeTimelineAssetInsertCompatibilityError(
            `Compatibility insertion for ${entry.request.assetPath} did not return an exact binding`,
          );
        }
        if (patched.binding.sourceFile !== entry.request.sourceFile) {
          throw new NativeTimelineAssetInsertCompatibilityError(
            `Compatibility insertion binding escaped source ${entry.request.sourceFile}`,
          );
        }
        compatibilityAfter[entry.request.sourceFile] = patched.content;
        plannedInsertions.push({ ...entry.request, binding: { ...patched.binding } });
      }

      const plan = planNativeTimelineAssetInsertions({
        document: current,
        insertions: plannedInsertions,
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
      for (const sourceFile of sourceFiles) {
        snapshots[sourceFile] = {
          before: compatibilityBefore[sourceFile]!,
          after: compatibilityAfter[sourceFile]!,
        };
      }
      const orderedPaths = [NATIVE_PROJECT_DOCUMENT_PATH, ...sourceFiles];
      await commitNativeTimelineFileSnapshots({
        orderedPaths,
        snapshots,
        history: {
          label: plan.insertions.length === 1 ? "Add timeline asset" : "Add timeline assets",
          kind: "timeline",
        },
        commitFileTransaction: input.commitFileTransaction,
        writeProjectFile: input.writeProjectFile,
        recordEdit: input.recordEdit,
        rollbackFailureMessage: "Native timeline asset insertion failed and rollback did not complete",
        signal: input.signal,
      });
      return {
        committed: true,
        document,
        nativeContent: nativeAfter,
        compatibilityContents: compatibilityAfter,
      };
    },
  );

  if (result.committed) input.onCommitted?.(result.document);
  return result;
}
