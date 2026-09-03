import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export interface DurableFileTransactionChange {
  /** Project-root-relative path. Transaction targets may not live in `.hyperframes`. */
  path: string;
  /** Exact UTF-8 content expected before the transaction; null means absent. */
  expectedBefore: string | null;
  /** Exact UTF-8 content after the transaction; null means absent. */
  after: string | null;
}

export type DurableFileTransactionHistoryKind = "manual" | "motion" | "timeline";

/** Metadata needed to reconstruct the browser's undo entry after a restart. */
export interface DurableFileTransactionHistory {
  label: string;
  kind: DurableFileTransactionHistoryKind;
  coalesceKey?: string;
  coalesceMs?: number;
}

export interface DurableFileTransactionInput {
  /** Stable client-generated id. Reusing it with the same payload is idempotent. */
  id: string;
  files: DurableFileTransactionChange[];
  /** Optional for backwards compatibility; new editor writes should provide it. */
  history?: DurableFileTransactionHistory;
}

export type DurableFileTransactionState = "PREPARED" | "COMMITTED" | "ROLLED_BACK";

export interface DurableFileTransactionReceipt {
  id: string;
  state: DurableFileTransactionState;
  /** Monotonic per-project commit ordering used for deterministic recovery. */
  sequence: number;
  digest: string;
  files: readonly DurableFileTransactionChange[];
  history?: DurableFileTransactionHistory;
  createdAt: string;
  updatedAt: string;
  journal: string;
}

export interface CorruptDurableFileTransactionReceipt {
  id: string | null;
  state: "CORRUPT";
  journal: string;
  error: string;
}

export type DurableFileTransactionStatus =
  | DurableFileTransactionReceipt
  | CorruptDurableFileTransactionReceipt;

export type DurableFileTransactionRecovery =
  | (DurableFileTransactionReceipt & {
      action: "rolled-back" | "reapplied" | "already-rolled-back";
    })
  | (CorruptDurableFileTransactionReceipt & { action: "corrupt" });

interface StoredJournal {
  formatVersion: 1;
  id: string;
  state: DurableFileTransactionState;
  sequence: number;
  digest: string;
  files: DurableFileTransactionChange[];
  history?: DurableFileTransactionHistory;
  createdAt: string;
  updatedAt: string;
  checksum: string;
}

export interface DurableFileTransactionStoreOptions {
  projectRoot: string;
  /** Test/diagnostic hook invoked only after the PREPARED receipt is durable. */
  afterPrepared?: (receipt: DurableFileTransactionReceipt) => void | Promise<void>;
  /** Test/diagnostic hook invoked after each durable target replacement. */
  afterTargetWrite?: (
    zeroBasedIndex: number,
    change: DurableFileTransactionChange,
  ) => void | Promise<void>;
  /** Test/diagnostic hook invoked only after the COMMITTED receipt is durable. */
  afterCommitted?: (receipt: DurableFileTransactionReceipt) => void | Promise<void>;
}

export interface DurableFileTransactionStore {
  commit(input: DurableFileTransactionInput): Promise<DurableFileTransactionReceipt>;
  recover(): Promise<DurableFileTransactionRecovery[]>;
  status(id: string): Promise<DurableFileTransactionStatus | null>;
  listReceipts(): Promise<DurableFileTransactionStatus[]>;
  listPending(): Promise<DurableFileTransactionReceipt[]>;
  /** COMMITTED receipts still awaiting browser history reconstruction and ACK. */
  listCommittedPendingHistory(): Promise<DurableFileTransactionReceipt[]>;
  acknowledge(id: string): Promise<boolean>;
}

const JOURNAL_PARENT = ".hyperframes";
const JOURNAL_DIRECTORY = "studio-transactions";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sharedOperationQueues = new Map<string, Promise<void>>();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function journalName(id: string): string {
  return `${sha256(id)}.json`;
}

function canonicalTransaction(input: DurableFileTransactionInput): string {
  return JSON.stringify({ id: input.id, files: input.files, history: input.history });
}

function journalBody(journal: Omit<StoredJournal, "checksum">): string {
  return JSON.stringify({
    formatVersion: journal.formatVersion,
    id: journal.id,
    state: journal.state,
    sequence: journal.sequence,
    digest: journal.digest,
    files: journal.files,
    history: journal.history,
    createdAt: journal.createdAt,
    updatedAt: journal.updatedAt,
  });
}

function sealJournal(journal: Omit<StoredJournal, "checksum">): StoredJournal {
  return { ...journal, checksum: sha256(journalBody(journal)) };
}

function publicReceipt(journal: StoredJournal): DurableFileTransactionReceipt {
  return {
    id: journal.id,
    state: journal.state,
    sequence: journal.sequence,
    digest: journal.digest,
    files: journal.files.map((file) => ({ ...file })),
    ...(journal.history ? { history: { ...journal.history } } : {}),
    createdAt: journal.createdAt,
    updatedAt: journal.updatedAt,
    journal: journalName(journal.id),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function pathEntry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function validateId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(
      "Unsafe transaction id: use 1-128 ASCII letters, digits, dots, underscores, colons, or hyphens",
    );
  }
}

function normalizeTargetPath(path: string): string {
  if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path)) {
    throw new Error(`Unsafe transaction target: ${JSON.stringify(path)} must be a relative path`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe transaction target: ${JSON.stringify(path)} contains traversal`);
  }
  const normalized = normalize(path);
  if (normalized !== path || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`Unsafe transaction target: ${JSON.stringify(path)} contains traversal`);
  }
  if (segments[0] === JOURNAL_PARENT) {
    throw new Error(`Reserved transaction target: ${JSON.stringify(path)} is inside .hyperframes`);
  }
  return normalized;
}

function normalizeHistory(history: unknown): DurableFileTransactionHistory | undefined {
  if (history === undefined) return undefined;
  if (!history || typeof history !== "object" || Array.isArray(history)) {
    throw new Error("Transaction history metadata must be an object");
  }
  const value = history as Record<string, unknown>;
  const allowed = new Set(["label", "kind", "coalesceKey", "coalesceMs"]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Transaction history metadata contains unexpected fields: ${unexpected.join(", ")}`);
  }
  if (
    typeof value.label !== "string" ||
    value.label.trim().length === 0 ||
    value.label.length > 512 ||
    value.label.includes("\0")
  ) {
    throw new Error("Transaction history label must be a non-empty string of at most 512 characters");
  }
  if (!new Set(["manual", "motion", "timeline"]).has(String(value.kind))) {
    throw new Error("Transaction history kind must be manual, motion, or timeline");
  }
  if (
    value.coalesceKey !== undefined &&
    (typeof value.coalesceKey !== "string" ||
      value.coalesceKey.trim().length === 0 ||
      value.coalesceKey.length > 512 ||
      value.coalesceKey.includes("\0"))
  ) {
    throw new Error(
      "Transaction history coalesceKey must be a non-empty string of at most 512 characters",
    );
  }
  if (
    value.coalesceMs !== undefined &&
    (typeof value.coalesceMs !== "number" ||
      !Number.isFinite(value.coalesceMs) ||
      value.coalesceMs < 0)
  ) {
    throw new Error("Transaction history coalesceMs must be a finite non-negative number");
  }
  return {
    label: value.label,
    kind: value.kind as DurableFileTransactionHistoryKind,
    ...(value.coalesceKey === undefined ? {} : { coalesceKey: value.coalesceKey as string }),
    ...(value.coalesceMs === undefined ? {} : { coalesceMs: value.coalesceMs as number }),
  };
}

function normalizeInput(input: DurableFileTransactionInput): DurableFileTransactionInput {
  validateId(input.id);
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new Error("A durable file transaction requires at least one target");
  }
  const seen = new Set<string>();
  const files = input.files.map((file) => {
    if (
      !file ||
      !(typeof file.expectedBefore === "string" || file.expectedBefore === null) ||
      !(typeof file.after === "string" || file.after === null)
    ) {
      throw new Error("Every transaction target requires exact expectedBefore and after content");
    }
    const path = normalizeTargetPath(file.path);
    if (seen.has(path)) throw new Error(`Duplicate transaction target: ${path}`);
    seen.add(path);
    return { path, expectedBefore: file.expectedBefore, after: file.after };
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  const history = normalizeHistory(input.history);
  return { id: input.id, files, ...(history ? { history } : {}) };
}

function isWithin(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
}

async function validateTarget(root: string, path: string): Promise<string> {
  const target = resolve(root, path);
  if (!isWithin(root, target)) throw new Error(`Unsafe transaction target escaped project: ${path}`);
  const parent = dirname(target);
  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch (error) {
    if (isMissing(error)) throw new Error(`Transaction target parent does not exist: ${path}`);
    throw error;
  }
  if (!isWithin(root, realParent)) {
    throw new Error(`Unsafe transaction target parent escapes project: ${path}`);
  }
  const entry = await pathEntry(target);
  if (entry?.isSymbolicLink()) throw new Error(`Unsafe transaction target is a symbolic link: ${path}`);
  if (entry && !entry.isFile()) throw new Error(`Transaction target is not a regular file: ${path}`);
  return target;
}

async function readExact(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    // Windows and some network filesystems do not permit opening directories.
    // File fsync + rename still provides the strongest available local guarantee.
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (!new Set(["EISDIR", "EINVAL", "EPERM", "EACCES", "ENOTSUP"]).has(String(code))) throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicReplace(path: string, content: string | null): Promise<void> {
  const parent = dirname(path);
  if (content === null) {
    await rm(path, { force: true });
    await syncDirectory(parent);
    return;
  }

  const temporary = join(parent, `.${randomUUID()}.studio-transaction.tmp`);
  let handle;
  try {
    let mode = 0o600;
    try {
      mode = (await stat(path)).mode;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(parent);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

function parseJournal(raw: string, filename: string): StoredJournal {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("Journal is not valid JSON");
  }
  if (!candidate || typeof candidate !== "object") throw new Error("Journal must be an object");
  const value = candidate as Partial<StoredJournal>;
  if (
    value.formatVersion !== 1 ||
    typeof value.id !== "string" ||
    !ID_PATTERN.test(value.id) ||
    !["PREPARED", "COMMITTED", "ROLLED_BACK"].includes(String(value.state)) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.digest !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.checksum !== "string" ||
    !Array.isArray(value.files) ||
    filename !== journalName(value.id)
  ) {
    throw new Error("Journal schema is invalid");
  }
  const normalized = normalizeInput({ id: value.id, files: value.files, history: value.history });
  const journalWithoutChecksum: Omit<StoredJournal, "checksum"> = {
    formatVersion: 1,
    id: value.id,
    state: value.state as DurableFileTransactionState,
    sequence: Number(value.sequence),
    digest: value.digest,
    files: normalized.files,
    ...(normalized.history ? { history: normalized.history } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (value.checksum !== sha256(journalBody(journalWithoutChecksum))) {
    throw new Error("Journal checksum is invalid");
  }
  if (value.digest !== sha256(canonicalTransaction(normalized))) {
    throw new Error("Journal transaction digest is invalid");
  }
  return { ...journalWithoutChecksum, checksum: value.checksum };
}

export function createDurableFileTransactionStore(
  options: DurableFileTransactionStoreOptions,
): DurableFileTransactionStore {
  const configuredRoot = resolve(options.projectRoot);
  let rootPromise: Promise<string> | null = null;

  const projectRoot = async (): Promise<string> => {
    rootPromise ??= realpath(configuredRoot);
    return rootPromise;
  };

  const journalDirectory = async (create: boolean): Promise<string | null> => {
    const root = await projectRoot();
    const parent = join(root, JOURNAL_PARENT);
    const directory = join(parent, JOURNAL_DIRECTORY);
    if (create) {
      const parentEntry = await pathEntry(parent);
      if (parentEntry?.isSymbolicLink() || (parentEntry && !parentEntry.isDirectory())) {
        throw new Error("Unsafe .hyperframes directory; refusing durable transaction journal access");
      }
      if (!parentEntry) await mkdir(parent);
      const directoryEntry = await pathEntry(directory);
      if (directoryEntry?.isSymbolicLink() || (directoryEntry && !directoryEntry.isDirectory())) {
        throw new Error("Unsafe studio transaction journal directory");
      }
      if (!directoryEntry) await mkdir(directory);
      const realDirectory = await realpath(directory);
      if (!isWithin(root, realDirectory)) throw new Error("Transaction journal escaped project root");
      return realDirectory;
    }
    const parentEntry = await pathEntry(parent);
    if (!parentEntry) return null;
    if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
      throw new Error("Unsafe .hyperframes directory; refusing durable transaction journal access");
    }
    const directoryEntry = await pathEntry(directory);
    if (!directoryEntry) return null;
    if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
      throw new Error("Unsafe studio transaction journal directory");
    }
    return directory;
  };

  const writeJournal = async (journal: StoredJournal): Promise<void> => {
    const directory = (await journalDirectory(true))!;
    await atomicReplace(join(directory, journalName(journal.id)), JSON.stringify(journal));
  };

  const readJournalFile = async (
    directory: string,
    filename: string,
  ): Promise<DurableFileTransactionStatus> => {
    try {
      const path = join(directory, filename);
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error("Journal is not a regular owned file");
      }
      return publicReceipt(parseJournal(await readFile(path, "utf8"), filename));
    } catch (error) {
      return {
        id: null,
        state: "CORRUPT",
        journal: filename,
        error: errorMessage(error),
      };
    }
  };

  const status = async (id: string): Promise<DurableFileTransactionStatus | null> => {
    validateId(id);
    const directory = await journalDirectory(false);
    if (!directory) return null;
    const filename = journalName(id);
    if (!(await pathEntry(join(directory, filename)))) return null;
    try {
      const result = await readJournalFile(directory, filename);
      if (result.state === "CORRUPT") return { ...result, id };
      return result;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };

  const listReceipts = async (): Promise<DurableFileTransactionStatus[]> => {
    const directory = await journalDirectory(false);
    if (!directory) return [];
    const filenames = (await readdir(directory))
      .filter((filename) => filename.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));
    return Promise.all(filenames.map((filename) => readJournalFile(directory, filename)));
  };

  const applyContents = async (
    journal: StoredJournal,
    side: "expectedBefore" | "after",
    invokeTargetHook: boolean,
  ): Promise<void> => {
    const root = await projectRoot();
    const resolvedTargets = await Promise.all(
      journal.files.map(async (change) => ({ change, target: await validateTarget(root, change.path) })),
    );
    for (let index = 0; index < resolvedTargets.length; index += 1) {
      const { change, target } = resolvedTargets[index];
      await atomicReplace(target, change[side]);
      if (invokeTargetHook) await options.afterTargetWrite?.(index, change);
    }
  };

  const recoverReceipt = async (
    receipt: DurableFileTransactionReceipt,
  ): Promise<DurableFileTransactionRecovery> => {
    const directory = (await journalDirectory(false))!;
    const journal = parseJournal(
      await readFile(join(directory, receipt.journal), "utf8"),
      receipt.journal,
    );
    if (journal.state === "PREPARED") {
      await applyContents(journal, "expectedBefore", false);
      const updated = sealJournal({
        ...journal,
        state: "ROLLED_BACK",
        updatedAt: new Date().toISOString(),
      });
      await writeJournal(updated);
      return { ...publicReceipt(updated), action: "rolled-back" };
    }
    if (journal.state === "COMMITTED") {
      await applyContents(journal, "after", false);
      return { ...publicReceipt(journal), action: "reapplied" };
    }
    return { ...publicReceipt(journal), action: "already-rolled-back" };
  };

  const runExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = sharedOperationQueues.get(configuredRoot) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    sharedOperationQueues.set(configuredRoot, settled);
    void settled.then(() => {
      if (sharedOperationQueues.get(configuredRoot) === settled) {
        sharedOperationQueues.delete(configuredRoot);
      }
    });
    return result;
  };

  const recover = (): Promise<DurableFileTransactionRecovery[]> =>
    runExclusive(async () => {
      const receipts = (await listReceipts()).sort((left, right) => {
        if (left.state === "CORRUPT" && right.state === "CORRUPT") {
          return left.journal.localeCompare(right.journal);
        }
        if (left.state === "CORRUPT") return 1;
        if (right.state === "CORRUPT") return -1;
        return left.sequence - right.sequence || left.journal.localeCompare(right.journal);
      });
      const results: DurableFileTransactionRecovery[] = [];
      for (const receipt of receipts) {
        if (receipt.state === "CORRUPT") {
          results.push({ ...receipt, action: "corrupt" });
          continue;
        }
        try {
          results.push(await recoverReceipt(receipt));
        } catch (error) {
          results.push({
            id: receipt.id,
            state: "CORRUPT",
            journal: receipt.journal,
            error: errorMessage(error),
            action: "corrupt",
          });
        }
      }
      return results;
    });

  const commit = (rawInput: DurableFileTransactionInput): Promise<DurableFileTransactionReceipt> =>
    runExclusive(async () => {
      const input = normalizeInput(rawInput);
      const digest = sha256(canonicalTransaction(input));
      let prior = await status(input.id);
      if (prior?.state === "CORRUPT") {
        throw new Error(`Transaction ${input.id} has a corrupt journal: ${prior.error}`);
      }
      if (prior && prior.digest !== digest) {
        throw new Error(`Transaction id ${input.id} already belongs to a different payload`);
      }
      if (prior?.state === "COMMITTED") {
        const root = await projectRoot();
        const resolvedTargets = await Promise.all(
          input.files.map(async (file) => ({ file, target: await validateTarget(root, file.path) })),
        );
        for (const { file, target } of resolvedTargets) {
          if ((await readExact(target)) !== file.after) await atomicReplace(target, file.after);
        }
        return prior;
      }
      if (prior?.state === "PREPARED") {
        await recoverReceipt(prior);
        prior = (await status(input.id)) as DurableFileTransactionReceipt;
      }

      const root = await projectRoot();
      const resolvedTargets = await Promise.all(
        input.files.map(async (file) => ({ file, target: await validateTarget(root, file.path) })),
      );
      const mismatches: string[] = [];
      for (const { file, target } of resolvedTargets) {
        if ((await readExact(target)) !== file.expectedBefore) mismatches.push(file.path);
      }
      if (mismatches.length > 0) {
        throw new Error(`Transaction target ${mismatches.join(", ")} changed before commit`);
      }

      const now = new Date().toISOString();
      const sequence = (await listReceipts()).reduce(
        (maximum, receipt) =>
          receipt.state === "CORRUPT" ? maximum : Math.max(maximum, receipt.sequence),
        0,
      ) + 1;
      const prepared = sealJournal({
        formatVersion: 1,
        id: input.id,
        state: "PREPARED",
        sequence,
        digest,
        files: input.files,
        ...(input.history ? { history: input.history } : {}),
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      });
      await writeJournal(prepared);
      const preparedReceipt = publicReceipt(prepared);
      await options.afterPrepared?.(preparedReceipt);

      for (let index = 0; index < resolvedTargets.length; index += 1) {
        const { file, target } = resolvedTargets[index];
        await atomicReplace(target, file.after);
        await options.afterTargetWrite?.(index, file);
      }

      const committed = sealJournal({
        ...prepared,
        state: "COMMITTED",
        updatedAt: new Date().toISOString(),
      });
      await writeJournal(committed);
      const committedReceipt = publicReceipt(committed);
      await options.afterCommitted?.(committedReceipt);
      return committedReceipt;
    });

  const acknowledge = (id: string): Promise<boolean> =>
    runExclusive(async () => {
      const receipt = await status(id);
      if (!receipt) return false;
      if (receipt.state === "CORRUPT") {
        throw new Error(`Cannot acknowledge corrupt transaction ${id}`);
      }
      if (receipt.state === "PREPARED") {
        throw new Error(`Cannot acknowledge PREPARED transaction ${id} before recovery`);
      }
      const directory = (await journalDirectory(false))!;
      await rm(join(directory, receipt.journal));
      await syncDirectory(directory);
      return true;
    });

  return {
    commit,
    recover,
    status,
    listReceipts,
    listPending: async () =>
      (await listReceipts()).filter(
        (receipt): receipt is DurableFileTransactionReceipt => receipt.state === "PREPARED",
      ),
    listCommittedPendingHistory: async () =>
      (await listReceipts()).filter(
        (receipt): receipt is DurableFileTransactionReceipt => receipt.state === "COMMITTED",
      ),
    acknowledge,
  };
}
