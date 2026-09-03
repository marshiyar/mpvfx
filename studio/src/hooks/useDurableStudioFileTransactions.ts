import { useCallback, useEffect } from "react";
import type { DurableRecordEditInput } from "./usePersistentEditHistory";
import type { CommitNativeTimelineFileTransaction } from "../project/nativeTimelineTransactionCommit";
import {
  commitDurableStudioFileTransaction,
  reconcileDurableStudioFileTransactions,
} from "../utils/studioFileTransaction";

interface UseDurableStudioFileTransactionsOptions {
  readonly projectId: string | null;
  readonly historyLoaded: boolean;
  readonly recordDurableEdit: (input: DurableRecordEditInput) => Promise<void>;
  readonly showToast: (message: string, tone?: "error" | "info") => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Binds native edits to the active project's crash journal and reconstructs
 * any committed-but-unacknowledged Undo entries after a reload.
 */
export function useDurableStudioFileTransactions(
  options: UseDurableStudioFileTransactionsOptions,
): CommitNativeTimelineFileTransaction {
  const { projectId, historyLoaded, recordDurableEdit, showToast } = options;

  useEffect(() => {
    if (!projectId || !historyLoaded) return;
    let active = true;
    void reconcileDurableStudioFileTransactions({ projectId, recordDurableEdit }).catch(
      (error) => {
        if (!active) return;
        showToast(`Saved edit recovery needs attention: ${errorMessage(error)}`, "error");
      },
    );
    return () => {
      active = false;
    };
  }, [historyLoaded, projectId, recordDurableEdit, showToast]);

  return useCallback<CommitNativeTimelineFileTransaction>(
    async (input) => {
      if (!projectId) {
        throw new Error("Cannot commit a durable edit without an active project");
      }
      await commitDurableStudioFileTransaction({
        projectId,
        files: input.files,
        history: input.history,
        recordDurableEdit,
      });
    },
    [projectId, recordDurableEdit],
  );
}
