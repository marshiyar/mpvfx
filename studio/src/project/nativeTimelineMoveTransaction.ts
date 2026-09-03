import type { RecordEditInput } from "../utils/studioFileHistory";
import { serializeStudioFileMutations } from "../utils/studioFileMutationCoordinator";
import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
  type NativeProjectTrackLane,
} from "./nativeProjectDocument";
import { NativeProjectRevisionConflictError } from "./nativeProjectPersistence";
import {
  planNativeTimelineClipMove,
  type NativeTimelineClipMovePlanFailureCode,
  type NativeTimelineMoveElement,
} from "./nativeTimelineClipMovePlan";
import {
  commitNativeTimelineFileSnapshots,
  type CommitNativeTimelineFileTransaction,
} from "./nativeTimelineTransactionCommit";

type ProjectFileWriter = (path: string, content: string, expectedContent?: string) => Promise<void>;

export interface CommitNativeTimelineMoveInput {
  readonly expectedRevision: number;
  readonly element: NativeTimelineMoveElement;
  readonly requestedStartSeconds: number;
  readonly requestedTrack: number;
  readonly readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  readonly writeProjectFile: ProjectFileWriter;
  readonly recordEdit: (input: RecordEditInput) => Promise<void>;
  readonly commitFileTransaction?: CommitNativeTimelineFileTransaction;
  readonly patchCompatibilityContent: (
    content: string,
    exactStartSeconds: number,
    destinationLane: Readonly<NativeProjectTrackLane>,
  ) => string;
  readonly onCommitted?: (document: NativeProjectDocument) => void;
  readonly signal?: AbortSignal;
}

export type CommitNativeTimelineMoveResult =
  | {
      readonly committed: true;
      readonly document: NativeProjectDocument;
      readonly nativeContent: string;
      readonly compatibilityContent: string;
    }
  | {
      readonly committed: false;
      readonly reason: NativeTimelineClipMovePlanFailureCode | "missing-native-project" | "missing-compatibility-file";
    };

export class NativeTimelineCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeTimelineCompatibilityError";
  }
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The native timeline move was aborted", "AbortError");
};

/**
 * Atomically persists the native-canonical move and its transitional HTML
 * mirror under the same per-file locks and undo entry. Ordinary write/history
 * failures are CAS-rolled back in reverse order. Publication occurs only after
 * the complete durable transaction has succeeded.
 */
export async function commitNativeTimelineMove(
  input: CommitNativeTimelineMoveInput,
): Promise<CommitNativeTimelineMoveResult> {
  const sourceFile = input.element.sourceFile;
  if (typeof sourceFile !== "string" || sourceFile.length === 0) {
    return { committed: false, reason: "clip-not-found" };
  }

  const result = await serializeStudioFileMutations(
    input.writeProjectFile,
    [NATIVE_PROJECT_DOCUMENT_PATH, sourceFile],
    async (): Promise<CommitNativeTimelineMoveResult> => {
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

      const plan = planNativeTimelineClipMove({
        document: current,
        element: input.element,
        requestedStartSeconds: input.requestedStartSeconds,
        requestedTrack: input.requestedTrack,
      });
      if (!plan.ok) return { committed: false, reason: plan.failure.code };
      if (plan.sourceFile !== sourceFile) {
        throw new NativeTimelineCompatibilityError(
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
        plan.compatibilityStartSeconds,
        {
          authoredTrack: plan.destination.authoredTrack,
          displayTrack: plan.destination.displayTrack,
        },
      );
      if (compatibilityAfter === compatibilityBefore) {
        throw new NativeTimelineCompatibilityError(
          `Compatibility source ${sourceFile} did not accept the native clip timing patch`,
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
      const orderedPaths = [NATIVE_PROJECT_DOCUMENT_PATH, sourceFile];
      await commitNativeTimelineFileSnapshots({
        orderedPaths,
        snapshots,
        history: {
          label: "Move timeline clip",
          kind: "timeline",
          coalesceKey: `timeline-move:${plan.address.clipId}`,
        },
        commitFileTransaction: input.commitFileTransaction,
        writeProjectFile: input.writeProjectFile,
        recordEdit: input.recordEdit,
        rollbackFailureMessage: "Native timeline move failed and rollback did not complete",
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
