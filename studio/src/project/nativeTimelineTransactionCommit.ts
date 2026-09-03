import type { RecordEditInput } from "../utils/studioFileHistory";

type ProjectFileWriter = (path: string, content: string, expectedContent?: string) => Promise<void>;

export interface NativeTimelineFileSnapshot {
  readonly before: string;
  readonly after: string;
}

export interface NativeTimelineDurableFileChange {
  readonly path: string;
  readonly expectedBefore: string | null;
  readonly after: string | null;
}

export interface NativeTimelineDurableCommitInput {
  readonly files: readonly NativeTimelineDurableFileChange[];
  readonly history: Omit<RecordEditInput, "files">;
}

export type CommitNativeTimelineFileTransaction = (
  input: NativeTimelineDurableCommitInput,
) => Promise<void>;

export interface CommitNativeTimelineFileSnapshotsInput {
  readonly orderedPaths: readonly string[];
  readonly snapshots: Readonly<Record<string, NativeTimelineFileSnapshot>>;
  readonly history: Omit<RecordEditInput, "files">;
  readonly commitFileTransaction?: CommitNativeTimelineFileTransaction;
  readonly writeProjectFile: ProjectFileWriter;
  readonly recordEdit: (input: RecordEditInput) => Promise<void>;
  readonly rollbackFailureMessage: string;
  readonly signal?: AbortSignal;
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The native timeline transaction was aborted", "AbortError");
};

/**
 * Commits the fully prepared native sidecar and compatibility mirrors. A
 * server-backed implementation is one crash-recoverable transaction. The
 * browser CAS/rollback path remains available for tests and older adapters.
 */
export async function commitNativeTimelineFileSnapshots(
  input: CommitNativeTimelineFileSnapshotsInput,
): Promise<void> {
  const uniquePaths = new Set(input.orderedPaths);
  if (uniquePaths.size !== input.orderedPaths.length) {
    throw new Error("Native timeline transaction contains duplicate file paths");
  }
  const files = input.orderedPaths.map((path) => {
    const snapshot = input.snapshots[path];
    if (!snapshot) throw new Error(`Native timeline transaction is missing ${path}`);
    return { path, expectedBefore: snapshot.before, after: snapshot.after };
  });

  throwIfAborted(input.signal);
  if (input.commitFileTransaction) {
    await input.commitFileTransaction({ files, history: input.history });
    return;
  }

  const written: string[] = [];
  try {
    for (const path of input.orderedPaths) {
      throwIfAborted(input.signal);
      const snapshot = input.snapshots[path]!;
      await input.writeProjectFile(path, snapshot.after, snapshot.before);
      written.push(path);
    }
    throwIfAborted(input.signal);
    await input.recordEdit({ ...input.history, files: { ...input.snapshots } });
  } catch (error) {
    try {
      for (const path of written.reverse()) {
        const snapshot = input.snapshots[path]!;
        await input.writeProjectFile(path, snapshot.before, snapshot.after);
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], input.rollbackFailureMessage);
    }
    throw error;
  }
}
