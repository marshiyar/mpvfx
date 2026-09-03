import type { RecordEditInput } from "../utils/studioFileHistory";
import { serializeStudioFileMutations } from "../utils/studioFileMutationCoordinator";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import {
  planNativeTimelineRangeEdit,
  type NativeTimelineCompatibilityRange,
  type NativeTimelineRangeEditElement,
  type NativeTimelineRangeEditPlanFailureCode,
} from "./nativeTimelineRangeEditPlan";
import {
  commitNativeTimelineFileSnapshots,
  type CommitNativeTimelineFileTransaction,
} from "./nativeTimelineTransactionCommit";

type ProjectFileWriter = (path: string, content: string, expectedContent?: string) => Promise<void>;

export interface CommitNativeTimelineRangeEditInput {
  readonly expectedRevision: number;
  readonly element: NativeTimelineRangeEditElement;
  readonly requestedStartSeconds: number;
  readonly requestedDurationSeconds: number;
  readonly readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  readonly writeProjectFile: ProjectFileWriter;
  readonly recordEdit: (input: RecordEditInput) => Promise<void>;
  readonly commitFileTransaction?: CommitNativeTimelineFileTransaction;
  readonly patchCompatibilityContent: (
    content: string,
    timing: NativeTimelineCompatibilityRange,
  ) => string;
  readonly onCommitted?: (document: NativeProjectDocument) => void;
  readonly signal?: AbortSignal;
}

export type CommitNativeTimelineRangeEditResult =
  | {
      readonly committed: true;
      readonly document: NativeProjectDocument;
      readonly nativeContent: string;
      readonly compatibilityContent: string;
    }
  | {
      readonly committed: false;
      readonly reason:
        | NativeTimelineRangeEditPlanFailureCode
        | "missing-native-project"
        | "missing-compatibility-file";
    };

export class NativeTimelineRangeCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeTimelineRangeCompatibilityError";
  }
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The native timeline range edit was aborted", "AbortError");
};

/**
 * Persist one native trim and its compatibility HTML mirror as a single durable
 * editor operation. Both files share the mutation coordinator locks, every
 * write uses compare-and-swap bytes, history is registered once, and rollback
 * restores successfully written files in reverse order before any publication.
 */
export async function commitNativeTimelineRangeEdit(
  input: CommitNativeTimelineRangeEditInput,
): Promise<CommitNativeTimelineRangeEditResult> {
  const sourceFile = input.element.sourceFile;
  if (typeof sourceFile !== "string" || sourceFile.length === 0) {
    return { committed: false, reason: "unbound-clip" };
  }

  const result = await serializeStudioFileMutations(
    input.writeProjectFile,
    [NATIVE_PROJECT_DOCUMENT_PATH, sourceFile],
    async (): Promise<CommitNativeTimelineRangeEditResult> => {
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

      const plan = planNativeTimelineRangeEdit({
        document: current,
        element: input.element,
        requestedStartSeconds: input.requestedStartSeconds,
        requestedDurationSeconds: input.requestedDurationSeconds,
      });
      if (!plan.ok) return { committed: false, reason: plan.failure.code };
      if (plan.sourceFile !== sourceFile) {
        throw new NativeTimelineRangeCompatibilityError(
          `Resolved clip source ${plan.sourceFile} does not match locked source ${sourceFile}`,
        );
      }

      const compatibilityBefore = await input.readOptionalProjectFile(sourceFile);
      throwIfAborted(input.signal);
      if (compatibilityBefore == null) {
        return { committed: false, reason: "missing-compatibility-file" };
      }
      const compatibilityAfter = input.patchCompatibilityContent(
        compatibilityBefore,
        plan.compatibility,
      );
      if (compatibilityAfter === compatibilityBefore) {
        throw new NativeTimelineRangeCompatibilityError(
          `Compatibility source ${sourceFile} did not accept the native clip range patch`,
        );
      }

      const document = parseNativeProjectDocument({
        ...plan.document,
        revision: current.revision + 1,
      });
      const nativeAfter = serializeNativeProjectDocument(document);
      const snapshots: Record<string, { before: string; after: string }> = {
        [NATIVE_PROJECT_DOCUMENT_PATH]: { before: nativeBefore, after: nativeAfter },
        [sourceFile]: { before: compatibilityBefore, after: compatibilityAfter },
      };
      await commitNativeTimelineFileSnapshots({
        orderedPaths: [NATIVE_PROJECT_DOCUMENT_PATH, sourceFile],
        snapshots,
        history: {
          label: "Trim timeline clip",
          kind: "timeline",
          coalesceKey: `timeline-resize:${plan.address.clipId}`,
        },
        commitFileTransaction: input.commitFileTransaction,
        writeProjectFile: input.writeProjectFile,
        recordEdit: input.recordEdit,
        rollbackFailureMessage: "Native timeline range edit failed and rollback did not complete",
        signal: input.signal,
      });

      return {
        committed: true,
        document,
        nativeContent: nativeAfter,
        compatibilityContent: compatibilityAfter,
      };
    },
  );

  if (result.committed) input.onCommitted?.(result.document);
  return result;
}
