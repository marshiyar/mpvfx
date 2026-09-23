import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildEditHistoryEntry,
  createEmptyEditHistory,
  hashEditHistoryContent,
  pushEditHistoryEntry,
  redoEditHistory,
  undoEditHistory,
  type BuildEditHistoryEntryInput,
  type EditHistoryEntry,
  type EditHistoryKind,
  type EditHistoryState,
  type EditHistoryTransitionResult,
} from "./editHistory";
import {
  createIndexedDbEditHistoryStorage,
  loadEditHistoryState,
  saveEditHistoryState,
  type EditHistoryStorageAdapter,
} from "./editHistoryStorage";
import type {
  AppliedStudioHistoryTransaction,
  StudioHistoryReplay,
  StudioHistoryTransactionInput,
} from "./studioFileTransaction";

export interface RecordEditInput {
  label: string;
  kind: EditHistoryKind;
  coalesceKey?: string;
  coalesceMs?: number;
  durableTransactionIds?: readonly string[];
  files: BuildEditHistoryEntryInput["files"];
  moves?: BuildEditHistoryEntryInput["moves"];
}

export interface DurableRecordEditInput extends RecordEditInput {
  durableTransactionIds: readonly string[];
  historyReplay?: StudioHistoryReplay;
}

export interface ApplyCallbacks {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  serialize?: <T>(paths: readonly string[], task: () => Promise<T>) => Promise<T>;
  applyTransaction?: (input: StudioHistoryTransactionInput) => Promise<AppliedStudioHistoryTransaction>;
}

interface UsePersistentEditHistoryOptions {
  projectId: string | null;
  storage?: EditHistoryStorageAdapter;
  now?: () => number;
}

/**
 * Per-file content the restore just applied. `restored` is the bytes written to
 * disk (the undo/redo target); `previous` is what was on disk immediately before
 * (the current live preview state). The undo preview-sync diffs these to decide
 * whether the restore is soft-reloadable (attributes/style/GSAP-script only) or
 * needs a full iframe reload.
 */
interface ApplyRestoredFile {
  previous: string;
  restored: string;
}

interface ApplyResult {
  ok: boolean;
  reason?: "empty" | "content-mismatch";
  label?: string;
  paths?: string[];
  files?: Record<string, ApplyRestoredFile>;
}

interface PersistentEditHistoryStoreOptions {
  projectId: string;
  storage: EditHistoryStorageAdapter;
  initialState: EditHistoryState;
  now?: () => number;
  onChange: (state: EditHistoryState) => void;
}

type EditHistoryMutation<T> = (state: EditHistoryState) => Promise<{
  state: EditHistoryState;
  result: T;
}>;

/** Pair the just-written (`restored`) bytes with the pre-write (`previous`) bytes per path. */
function restoredFilesMap(
  filesToWrite: Record<string, string>,
  currentFiles: Record<string, string>,
): Record<string, ApplyRestoredFile> {
  const out: Record<string, ApplyRestoredFile> = {};
  for (const [path, restored] of Object.entries(filesToWrite)) {
    out[path] = { previous: currentFiles[path] ?? "", restored };
  }
  return out;
}

function createEntryId(now: number): string {
  return `edit-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function snapshotEditHistoryState(state: EditHistoryState) {
  const undoEntry = state.undo[state.undo.length - 1] ?? null;
  const redoEntry = state.redo[state.redo.length - 1] ?? null;
  return {
    canUndo: Boolean(undoEntry),
    canRedo: Boolean(redoEntry),
    undoLabel: undoEntry?.label ?? null,
    redoLabel: redoEntry?.label ?? null,
    undoPaths: undoEntry ? entryPaths(undoEntry) : [],
    redoPaths: redoEntry ? entryPaths(redoEntry) : [],
    state,
  };
}

function entryPaths(entry: EditHistoryEntry): string[] {
  return [...new Set([...Object.keys(entry.files), ...(entry.moves ?? []).flatMap(move => [move.from, move.to])])];
}

function attachReplayReceipts(state: EditHistoryState, entryId: string, receiptIds: readonly string[]): EditHistoryState {
  const attach = (entry: EditHistoryEntry): EditHistoryEntry => entry.id === entryId
    ? { ...entry, durableTransactionIds: [...new Set([...(entry.durableTransactionIds ?? []), ...receiptIds])] }
    : entry;
  return { ...state, undo: state.undo.map(attach), redo: state.redo.map(attach) };
}

function recoverHistoryReplay(state: EditHistoryState, input: DurableRecordEditInput, now: number): EditHistoryState {
  const replay = input.historyReplay!;
  if ([...state.undo, ...state.redo].some(entry => input.durableTransactionIds.some(id => entry.durableTransactionIds?.includes(id)))) return state;
  const entry = state[replay.direction].at(-1);
  if (!entry || entry.id !== replay.entryId) throw new Error(`Cannot reconcile ${replay.direction}: the original history entry is not at the expected position`);
  // Disk already contains the committed replay. Only restore its stack position;
  // applying its file snapshots again could overwrite a later committed edit.
  const hashes = Object.fromEntries(Object.entries(entry.files).map(([path, snapshot]) => [path,
    replay.direction === "undo" ? snapshot.afterHash : snapshot.beforeHash,
  ]));
  const transition = replay.direction === "undo" ? undoEditHistory : redoEditHistory;
  const result = transition(state, hashes, now);
  if (!result.ok) throw new Error("Committed history replay could not be reconciled");
  return attachReplayReceipts(result.state, entry.id, input.durableTransactionIds);
}

async function readCurrentFileHashes(
  paths: string[],
  readFile: (path: string) => Promise<string>,
): Promise<{
  currentFiles: Record<string, string>;
  currentHashes: Record<string, string>;
}> {
  const currentFiles: Record<string, string> = {};
  const currentHashes: Record<string, string> = {};
  for (const path of paths) {
    const content = await readFile(path);
    currentFiles[path] = content;
    currentHashes[path] = hashEditHistoryContent(content);
  }
  return { currentFiles, currentHashes };
}

async function writeFilesWithRollback({
  files,
  rollbackFiles,
  writeFile,
}: {
  files: Record<string, string>;
  rollbackFiles: Record<string, string>;
  writeFile: (path: string, content: string) => Promise<void>;
}): Promise<void> {
  const writtenPaths: string[] = [];
  try {
    for (const [path, content] of Object.entries(files)) {
      await writeFile(path, content);
      writtenPaths.push(path);
    }
  } catch (error) {
    try {
      for (const path of writtenPaths.reverse()) {
        await writeFile(path, rollbackFiles[path]);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Failed to apply edit history and rollback did not complete",
      );
    }
    throw error;
  }
}

/**
 * Apply one undo/redo step: read current on-disk hashes, run the direction's
 * transition, write the restored files with rollback, and shape the ApplyResult.
 * `entry` is the stack top used to know which paths to hash before applying.
 */
async function applyHistoryStep(
  currentState: EditHistoryState,
  entry: EditHistoryEntry | undefined,
  transition: (
    state: EditHistoryState,
    currentHashes: Record<string, string>,
    now: number,
  ) => EditHistoryTransitionResult,
  now: () => number,
  callbacks: ApplyCallbacks,
  direction: "undo" | "redo",
  persist: (state: EditHistoryState) => Promise<void>,
  deferCompensation: (state: EditHistoryState, acknowledge: () => Promise<void>) => void,
): Promise<{ state: EditHistoryState; result: ApplyResult }> {
  if (!entry) {
    return { state: currentState, result: { ok: false, reason: "empty" } };
  }
  const paths = entryPaths(entry);
  const apply = async (): Promise<{ state: EditHistoryState; result: ApplyResult }> => {
    if (entry.moves?.length && !callbacks.applyTransaction) throw new Error("Media history requires an atomic file transaction");
    const { currentFiles, currentHashes } = await readCurrentFileHashes(Object.keys(entry.files), async path => {
      const snapshot = entry.files[path]!;
      const absent = direction === "undo" ? snapshot.afterExists === false : snapshot.beforeExists === false;
      return absent && callbacks.applyTransaction ? "" : callbacks.readFile(path);
    });
    if (Object.entries(entry.files).some(([path, snapshot]) => currentFiles[path] !== (direction === "undo" ? snapshot.after : snapshot.before))) {
      return { state: currentState, result: { ok: false, reason: "content-mismatch" } };
    }
    const result = transition(currentState, currentHashes, now());
    if (!result.ok) {
      return {
        state: currentState,
        result: { ok: false, reason: result.reason },
      };
    }
    const transaction: StudioHistoryTransactionInput = {
      files: Object.entries(entry.files).map(([path, snapshot]) => ({
        path,
        expectedBefore: direction === "undo"
          ? (snapshot.afterExists === false ? null : snapshot.after)
          : (snapshot.beforeExists === false ? null : snapshot.before),
        after: direction === "undo"
          ? (snapshot.beforeExists === false ? null : snapshot.before)
          : (snapshot.afterExists === false ? null : snapshot.after),
      })),
      moves: direction === "undo" ? [...(entry.moves ?? [])].reverse().map(move => ({ ...move, from: move.to, to: move.from })) : entry.moves,
      historyReplay: { entryId: entry.id, direction },
    };
    let applied: AppliedStudioHistoryTransaction | undefined;
    if (callbacks.applyTransaction) applied = await callbacks.applyTransaction(transaction);
    else await writeFilesWithRollback({ files: result.filesToWrite, rollbackFiles: currentFiles, writeFile: callbacks.writeFile });
    const nextState = applied ? attachReplayReceipts(result.state, entry.id, [applied.id]) : result.state;
    try {
      await persist(nextState);
    } catch (error) {
      let rollback: AppliedStudioHistoryTransaction | undefined;
      try {
        if (callbacks.applyTransaction) {
          rollback = await callbacks.applyTransaction({
            files: transaction.files.map(file => ({ path: file.path, expectedBefore: file.after, after: file.expectedBefore })),
            moves: [...(transaction.moves ?? [])].reverse().map(move => ({ ...move, from: move.to, to: move.from })),
            historyReplay: { entryId: entry.id, direction: direction === "undo" ? "redo" : "undo" },
          });
        } else {
          await writeFilesWithRollback({ files: currentFiles, rollbackFiles: result.filesToWrite, writeFile: callbacks.writeFile });
        }
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "History persistence failed and its file rollback could not be completed");
      }
      if (applied && rollback) {
        const compensatedState = attachReplayReceipts(currentState, entry.id, [applied.id, rollback.id]);
        const acknowledgeCompensation = async () => { await applied!.acknowledge(); await rollback!.acknowledge(); };
        // Persist both receipt identities before acknowledging either one. If
        // storage stays unavailable, startup recovers the ordered replay pair.
        try { await persist(compensatedState); }
        catch (persistenceError) {
          deferCompensation(compensatedState, acknowledgeCompensation);
          throw new AggregateError([error, persistenceError], "Files were restored, but Undo history is waiting for durable storage");
        }
        await acknowledgeCompensation().catch(() => undefined);
      }
      throw error;
    }
    // The stack and files are already durable. A lost ACK leaves a receipt for
    // idempotent startup reconciliation; it must not make the applied edit look
    // like a failure or prevent the preview from displaying its new state.
    await applied?.acknowledge().catch(() => undefined);
    return {
      state: nextState,
      result: {
        ok: true,
        label: result.entry.label,
        paths,
        files: restoredFilesMap(result.filesToWrite, currentFiles),
      },
    };
  };
  return callbacks.serialize ? callbacks.serialize(paths, apply) : apply();
}

export function createPersistentEditHistoryStore({
  projectId,
  storage,
  initialState,
  now = Date.now,
  onChange,
}: PersistentEditHistoryStoreOptions) {
  let state = initialState;
  let queue = Promise.resolve();
  let pendingCompensation: { state: EditHistoryState; acknowledge: () => Promise<void> } | undefined;
  const deferCompensation = (nextState: EditHistoryState, acknowledge: () => Promise<void>) => {
    pendingCompensation = { state: nextState, acknowledge };
  };

  const saveGracefully = async (nextState: EditHistoryState) => {
    state = nextState;
    onChange(nextState);
    try {
      await saveEditHistoryState(storage, projectId, nextState);
    } catch {
      // Keep in-memory history usable when IndexedDB is unavailable.
    }
  };

  const saveDurably = async (nextState: EditHistoryState) => {
    // A durable server receipt is a recovery boundary. Publish it to React and
    // the controller only after storage confirms it can survive a reload.
    await saveEditHistoryState(storage, projectId, nextState);
    state = nextState;
    onChange(nextState);
  };

  const mutate = async <T>(
    mutation: EditHistoryMutation<T>,
    persistence: "graceful" | "durable" = "graceful",
  ): Promise<T> => {
    const run = queue.then(async () => {
      if (pendingCompensation) {
        await saveDurably(pendingCompensation.state);
        await pendingCompensation.acknowledge().catch(() => undefined);
        pendingCompensation = undefined;
      }
      const { state: nextState, result } = await mutation(state);
      if (nextState !== state) {
        if (persistence === "durable") await saveDurably(nextState);
        else await saveGracefully(nextState);
      }
      return result;
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    snapshot: () => snapshotEditHistoryState(state),
    async recordEdit(input: RecordEditInput) {
      await mutate<void>(async (currentState) => {
        const timestamp = now();
        const entry = buildEditHistoryEntry({
          ...input,
          id: createEntryId(timestamp),
          projectId,
          now: timestamp,
        });
        return {
          state: pushEditHistoryEntry(currentState, entry),
          result: undefined,
        };
      });
    },
    async recordDurableEdit(input: DurableRecordEditInput) {
      if (!input.durableTransactionIds.some((id) => id.length > 0)) {
        throw new Error("A durable edit requires at least one non-empty durable transaction ID");
      }
      await mutate<void>(async (currentState) => {
        const timestamp = now();
        if (input.historyReplay) return { state: recoverHistoryReplay(currentState, input, timestamp), result: undefined };
        const entry = buildEditHistoryEntry({
          ...input,
          id: createEntryId(timestamp),
          projectId,
          now: timestamp,
        });
        return {
          state: pushEditHistoryEntry(currentState, entry),
          result: undefined,
        };
      }, "durable");
    },
    async undo(callbacks: ApplyCallbacks): Promise<ApplyResult> {
      return mutate<ApplyResult>((currentState) =>
        applyHistoryStep(
          currentState,
          currentState.undo[currentState.undo.length - 1],
          undoEditHistory,
          now,
          callbacks,
          "undo",
          saveDurably,
          deferCompensation,
        ),
      );
    },
    async redo(callbacks: ApplyCallbacks): Promise<ApplyResult> {
      return mutate<ApplyResult>((currentState) =>
        applyHistoryStep(
          currentState,
          currentState.redo[currentState.redo.length - 1],
          redoEditHistory,
          now,
          callbacks,
          "redo",
          saveDurably,
          deferCompensation,
        ),
      );
    },
  };
}

export async function createPersistentEditHistoryController({
  projectId,
  storage,
  now = Date.now,
  onChange,
}: {
  projectId: string;
  storage: EditHistoryStorageAdapter;
  now?: () => number;
  onChange: (state: EditHistoryState) => void;
}) {
  let state = await loadEditHistoryState(storage, projectId);
  const store = createPersistentEditHistoryStore({
    projectId,
    storage,
    initialState: state,
    now,
    onChange: (nextState) => {
      state = nextState;
      onChange(nextState);
    },
  });

  return store;
}

export function usePersistentEditHistory(options: UsePersistentEditHistoryOptions) {
  const storage = useMemo(
    () => options.storage ?? createIndexedDbEditHistoryStorage(),
    [options.storage],
  );
  const now = options.now ?? Date.now;
  const [state, setState] = useState<EditHistoryState>(() => createEmptyEditHistory());
  const [loaded, setLoaded] = useState(false);
  const projectId = options.projectId;
  const storeRef = useRef<ReturnType<typeof createPersistentEditHistoryStore> | null>(null);
  const storeProjectIdRef = useRef<string | null>(null);
  const activeProjectIdRef = useRef(projectId);
  activeProjectIdRef.current = projectId;

  useEffect(() => {
    let cancelled = false;
    const emptyState = createEmptyEditHistory();
    storeRef.current = null;
    storeProjectIdRef.current = null;
    setState(emptyState);
    setLoaded(false);
    if (!projectId) {
      setLoaded(true);
      return;
    }

    loadEditHistoryState(storage, projectId)
      .then((loadedState) => {
        if (cancelled) return;
        storeRef.current = createPersistentEditHistoryStore({
          projectId,
          storage,
          initialState: loadedState,
          now,
          onChange: (nextState) => {
            if (!cancelled && activeProjectIdRef.current === projectId) setState(nextState);
          },
        });
        storeProjectIdRef.current = projectId;
        setState(loadedState);
      })
      .catch(() => {
        if (cancelled) return;
        storeRef.current = createPersistentEditHistoryStore({
          projectId,
          storage,
          initialState: emptyState,
          now,
          onChange: (nextState) => {
            if (!cancelled && activeProjectIdRef.current === projectId) setState(nextState);
          },
        });
        storeProjectIdRef.current = projectId;
        setState(emptyState);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [now, projectId, storage]);

  const recordEdit = useCallback(
    async (input: RecordEditInput) => {
      if (!projectId) return;
      if (activeProjectIdRef.current !== projectId) {
        throw new Error(`Cannot record an edit for inactive project ${projectId}`);
      }
      const store = storeRef.current;
      if (!store) return;
      if (storeProjectIdRef.current !== projectId) {
        throw new Error(`Edit history store does not belong to project ${projectId}`);
      }
      await store.recordEdit(input);
    },
    [projectId],
  );

  const recordDurableEdit = useCallback(
    async (input: DurableRecordEditInput) => {
      if (!projectId) {
        throw new Error("Cannot durably record an edit without an active project");
      }
      if (activeProjectIdRef.current !== projectId) {
        throw new Error(`Cannot record an edit for inactive project ${projectId}`);
      }
      const store = storeRef.current;
      if (!store) {
        throw new Error(`Edit history store is not ready for project ${projectId}`);
      }
      if (storeProjectIdRef.current !== projectId) {
        throw new Error(`Edit history store does not belong to project ${projectId}`);
      }
      await store.recordDurableEdit(input);
    },
    [projectId],
  );

  const undo = useCallback(
    async (callbacks: ApplyCallbacks): Promise<ApplyResult> => {
      if (
        !projectId ||
        activeProjectIdRef.current !== projectId ||
        storeProjectIdRef.current !== projectId
      ) {
        return { ok: false, reason: "empty" };
      }
      return storeRef.current?.undo(callbacks) ?? { ok: false, reason: "empty" };
    },
    [projectId],
  );

  const redo = useCallback(
    async (callbacks: ApplyCallbacks): Promise<ApplyResult> => {
      if (
        !projectId ||
        activeProjectIdRef.current !== projectId ||
        storeProjectIdRef.current !== projectId
      ) {
        return { ok: false, reason: "empty" };
      }
      return storeRef.current?.redo(callbacks) ?? { ok: false, reason: "empty" };
    },
    [projectId],
  );

  return {
    loaded,
    ...snapshotEditHistoryState(state),
    recordEdit,
    recordDurableEdit,
    undo,
    redo,
  };
}
