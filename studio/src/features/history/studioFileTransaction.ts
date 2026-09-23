import { desktopRequest } from "../../lib/desktopClient";
import type { DurableRecordEditInput } from "./usePersistentEditHistory";
import type { EditHistoryKind } from "./editHistory";
import { createStudioWriteToken, markStudioWriteToken } from "./studioFileVersion";
import { StudioSaveHttpError } from "./studioSaveDiagnostics";
import type { ProjectFileMove, ProjectHistoryReplay } from "../../../shared/desktopBridge";

export type StudioHistoryReplay = ProjectHistoryReplay;

export interface StudioDurableFileTransactionChange {
  path: string;
  expectedBefore: string | null;
  after: string | null;
}

export interface StudioDurableFileTransactionHistory {
  label: string;
  kind: EditHistoryKind;
  coalesceKey?: string;
  coalesceMs?: number;
}

export interface StudioDurableFileTransactionReceipt {
  id: string;
  state: "COMMITTED";
  sequence: number;
  files: StudioDurableFileTransactionChange[];
  moves?: ProjectFileMove[];
  history?: StudioDurableFileTransactionHistory;
  historyReplay?: StudioHistoryReplay;
  digest?: string;
  createdAt?: string;
  updatedAt?: string;
  journal?: string;
}

type RecordDurableEdit = (input: DurableRecordEditInput) => Promise<void> | void;
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface DurableFileTransactionClientDependencies {
  projectId: string;
  fetchImpl?: FetchImplementation;
  recordDurableEdit: RecordDurableEdit;
}

export interface CommitDurableStudioFileTransactionInput
  extends DurableFileTransactionClientDependencies {
  transactionId?: string;
  files: readonly StudioDurableFileTransactionChange[];
  moves?: readonly ProjectFileMove[];
  history: StudioDurableFileTransactionHistory;
  createTransactionId?: () => string;
}

export class DurableStudioHistoryPendingError extends Error {
  readonly transactionId: string;
  readonly cause: unknown;

  constructor(transactionId: string, cause: unknown) {
    super(
      `Edit ${transactionId} is saved, but its Undo history is pending startup reconciliation`,
    );
    this.name = "DurableStudioHistoryPendingError";
    this.transactionId = transactionId;
    this.cause = cause;
  }
}

function apiRoot(projectId: string): string {
  if (!projectId) throw new Error("A durable Studio transaction requires an active project");
  return `/api/projects/${encodeURIComponent(projectId)}/file-transactions`;
}

function defaultTransactionId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error("This browser cannot create a durable transaction ID");
  return id;
}

async function responseJson(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && typeof Reflect.get(body, "error") === "string"
        ? String(Reflect.get(body, "error"))
        : `Durable file transaction failed (${response.status})`;
    throw new StudioSaveHttpError(message, response.status);
  }
  return body;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Durable transaction receipt has an invalid ${field}`);
  }
  return value;
}

function parseHistory(value: unknown): StudioDurableFileTransactionHistory | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error("Durable transaction receipt has invalid history metadata");
  }
  const label = requiredString(Reflect.get(value, "label"), "history label");
  const kind = Reflect.get(value, "kind");
  if (kind !== "manual" && kind !== "motion" && kind !== "timeline") {
    throw new Error("Durable transaction receipt has an invalid history kind");
  }
  const coalesceKey = Reflect.get(value, "coalesceKey");
  const coalesceMs = Reflect.get(value, "coalesceMs");
  if (coalesceKey !== undefined && typeof coalesceKey !== "string") {
    throw new Error("Durable transaction receipt has an invalid history coalesceKey");
  }
  if (
    coalesceMs !== undefined &&
    (typeof coalesceMs !== "number" || !Number.isFinite(coalesceMs) || coalesceMs < 0)
  ) {
    throw new Error("Durable transaction receipt has an invalid history coalesceMs");
  }
  return {
    label,
    kind,
    ...(coalesceKey === undefined ? {} : { coalesceKey }),
    ...(coalesceMs === undefined ? {} : { coalesceMs }),
  };
}

export function parseStudioDurableFileTransactionReceipt(value: unknown): StudioDurableFileTransactionReceipt {
  if (!value || typeof value !== "object") {
    throw new Error("Durable transaction server returned an invalid receipt");
  }
  const id = requiredString(Reflect.get(value, "id"), "id");
  if (Reflect.get(value, "state") !== "COMMITTED") {
    throw new Error(`Durable transaction ${id} was not committed`);
  }
  const sequence = Reflect.get(value, "sequence");
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) {
    throw new Error(`Durable transaction ${id} has an invalid sequence`);
  }
  const rawFiles = Reflect.get(value, "files");
  if (!Array.isArray(rawFiles)) {
    throw new Error(`Durable transaction ${id} has invalid file snapshots`);
  }
  const files = rawFiles.map((rawFile, index): StudioDurableFileTransactionChange => {
    if (!rawFile || typeof rawFile !== "object") {
      throw new Error(`Durable transaction ${id} has an invalid file snapshot at ${index}`);
    }
    const path = requiredString(Reflect.get(rawFile, "path"), `file path at ${index}`);
    const expectedBefore = Reflect.get(rawFile, "expectedBefore");
    const after = Reflect.get(rawFile, "after");
    if (
      !(typeof expectedBefore === "string" || expectedBefore === null) ||
      !(typeof after === "string" || after === null)
    ) {
      throw new Error(`Durable transaction ${id} has invalid bytes for ${path}`);
    }
    return { path, expectedBefore, after };
  });
  const rawMoves = Reflect.get(value, "moves");
  if (rawMoves !== undefined && !Array.isArray(rawMoves)) {
    throw new Error(`Durable transaction ${id} has invalid file moves`);
  }
  const movePaths = new Set<string>();
  const moves = (rawMoves ?? []).map((rawMove: unknown): ProjectFileMove => {
    if (!rawMove || typeof rawMove !== "object") throw new Error(`Durable transaction ${id} has invalid file moves`);
    const from = requiredString(Reflect.get(rawMove, "from"), "move source");
    const to = requiredString(Reflect.get(rawMove, "to"), "move destination");
    const expectedVersion = requiredString(Reflect.get(rawMove, "expectedVersion"), "move version");
    if (from === to || movePaths.has(from) || movePaths.has(to) || !/^[a-f\d]{64}$/.test(expectedVersion)) {
      throw new Error(`Durable transaction ${id} has an invalid or ambiguous file move`);
    }
    movePaths.add(from);
    movePaths.add(to);
    return { from, to, expectedVersion };
  });
  if (!files.length && !moves.length) throw new Error(`Durable transaction ${id} has no file changes`);
  const rawReplay = Reflect.get(value, "historyReplay");
  let historyReplay: StudioHistoryReplay | undefined;
  if (rawReplay !== undefined) {
    if (!rawReplay || typeof rawReplay !== "object" || Reflect.get(value, "history") !== undefined) {
      throw new Error(`Durable transaction ${id} has invalid history replay metadata`);
    }
    const entryId = requiredString(Reflect.get(rawReplay, "entryId"), "history entry ID");
    const direction = Reflect.get(rawReplay, "direction");
    if (direction !== "undo" && direction !== "redo") throw new Error(`Durable transaction ${id} has invalid history direction`);
    historyReplay = { entryId, direction };
  }
  return {
    id,
    state: "COMMITTED",
    sequence: Number(sequence),
    files,
    ...(moves.length ? { moves } : {}),
    ...(historyReplay ? { historyReplay } : {}),
    ...(parseHistory(Reflect.get(value, "history"))
      ? { history: parseHistory(Reflect.get(value, "history")) }
      : {}),
    ...(typeof Reflect.get(value, "digest") === "string"
      ? { digest: String(Reflect.get(value, "digest")) }
      : {}),
    ...(typeof Reflect.get(value, "createdAt") === "string"
      ? { createdAt: String(Reflect.get(value, "createdAt")) }
      : {}),
    ...(typeof Reflect.get(value, "updatedAt") === "string"
      ? { updatedAt: String(Reflect.get(value, "updatedAt")) }
      : {}),
    ...(typeof Reflect.get(value, "journal") === "string"
      ? { journal: String(Reflect.get(value, "journal")) }
      : {}),
  };
}

function historyInputFromReceipt(
  receipt: StudioDurableFileTransactionReceipt,
): DurableRecordEditInput {
  if (receipt.historyReplay) {
    return {
      label: receipt.historyReplay.direction,
      kind: "manual",
      files: {},
      durableTransactionIds: [receipt.id],
      historyReplay: receipt.historyReplay,
    };
  }
  if (!receipt.history) {
    throw new Error(`Durable transaction ${receipt.id} is missing Undo history metadata`);
  }
  const files: DurableRecordEditInput["files"] = {};
  for (const file of receipt.files) {
    files[file.path] = {
      before: file.expectedBefore ?? "", after: file.after ?? "",
      ...(file.expectedBefore === null ? { beforeExists: false } : {}),
      ...(file.after === null ? { afterExists: false } : {}),
    };
  }
  return {
    ...receipt.history,
    durableTransactionIds: [receipt.id],
    files,
    ...(receipt.moves?.length ? { moves: receipt.moves } : {}),
  };
}

async function acknowledge(
  root: string,
  receiptId: string,
  fetchImpl: FetchImplementation,
): Promise<void> {
  const response = await fetchImpl(
    `${root}/${encodeURIComponent(receiptId)}/acknowledge`,
    { method: "POST" },
  );
  const body = await responseJson(response);
  if (!body || typeof body !== "object" || Reflect.get(body, "ok") !== true) {
    throw new Error(`Durable transaction ${receiptId} acknowledgement was not confirmed`);
  }
}

async function requestDurableStudioFileTransaction(
  input: Omit<CommitDurableStudioFileTransactionInput, "recordDurableEdit" | "history"> & {
    history?: StudioDurableFileTransactionHistory;
    historyReplay?: StudioHistoryReplay;
  },
): Promise<StudioDurableFileTransactionReceipt> {
  const fetchImpl = input.fetchImpl ?? desktopRequest;
  const root = apiRoot(input.projectId);
  const id = input.transactionId ?? (input.createTransactionId ?? defaultTransactionId)();
  const writeTokens = Object.fromEntries(
    [...new Set([...input.files.map(file => file.path), ...(input.moves ?? []).flatMap(move => [move.from, move.to])])].map((path) => {
      const token = createStudioWriteToken();
      markStudioWriteToken(token);
      return [path, token];
    }),
  );
  let receipt: StudioDurableFileTransactionReceipt;
  try {
    const response = await fetchImpl(`${root}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, files: input.files, ...(input.moves?.length ? { moves: input.moves } : {}), history: input.history, historyReplay: input.historyReplay, writeTokens }),
    });
    receipt = parseStudioDurableFileTransactionReceipt(await responseJson(response));
  } catch (error) {
    if (error instanceof StudioSaveHttpError && error.statusCode < 500) throw error;
    // A lost response does not mean the write failed. Recover its receipt
    // before reporting failure; never submit the edit again under a new ID.
    try {
      receipt = parseStudioDurableFileTransactionReceipt(await responseJson(await fetchImpl(`${root}/${encodeURIComponent(id)}`)));
    } catch {
      throw error;
    }
  }
  if (receipt.id !== id) {
    throw new Error(`Durable transaction receipt id ${receipt.id} does not match ${id}`);
  }
  return receipt;
}

/** Finalize a receipt returned by a media rename/delete endpoint without resubmitting it. */
export async function finalizeDurableStudioFileTransaction(
  input: DurableFileTransactionClientDependencies & { receipt: unknown },
): Promise<StudioDurableFileTransactionReceipt> {
  const receipt = parseStudioDurableFileTransactionReceipt(input.receipt);
  try {
    await input.recordDurableEdit(historyInputFromReceipt(receipt));
    await acknowledge(apiRoot(input.projectId), receipt.id, input.fetchImpl ?? desktopRequest);
  } catch (error) {
    throw new DurableStudioHistoryPendingError(receipt.id, error);
  }
  return receipt;
}

export async function commitDurableStudioFileTransaction(
  input: CommitDurableStudioFileTransactionInput,
): Promise<StudioDurableFileTransactionReceipt> {
  const receipt = await requestDurableStudioFileTransaction(input);
  return finalizeDurableStudioFileTransaction({ ...input, receipt });
}

export interface StudioHistoryTransactionInput {
  files: readonly StudioDurableFileTransactionChange[];
  moves?: readonly ProjectFileMove[];
  historyReplay: StudioHistoryReplay;
}

export interface AppliedStudioHistoryTransaction {
  id: string;
  acknowledge: () => Promise<void>;
}

/** History publishes its stack transition before acknowledging this atomic replay. */
export async function applyDurableStudioHistoryTransaction(
  input: StudioHistoryTransactionInput & { projectId: string; fetchImpl?: FetchImplementation; transactionId?: string },
): Promise<AppliedStudioHistoryTransaction> {
  const receipt = await requestDurableStudioFileTransaction(input);
  if (receipt.historyReplay?.entryId !== input.historyReplay.entryId || receipt.historyReplay.direction !== input.historyReplay.direction) {
    throw new Error(`Durable transaction ${receipt.id} did not confirm the requested history replay`);
  }
  return { id: receipt.id, acknowledge: () => acknowledge(apiRoot(input.projectId), receipt.id, input.fetchImpl ?? desktopRequest) };
}

export async function reconcileDurableStudioFileTransactions(
  input: DurableFileTransactionClientDependencies,
): Promise<{ reconciled: number }> {
  const fetchImpl = input.fetchImpl ?? desktopRequest;
  const root = apiRoot(input.projectId);
  const response = await fetchImpl(`${root}/pending-history`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const body = await responseJson(response);
  const rawReceipts =
    body && typeof body === "object" ? Reflect.get(body, "receipts") : undefined;
  if (!Array.isArray(rawReceipts)) {
    throw new Error("Durable transaction server returned an invalid pending-history response");
  }
  const receipts = rawReceipts.map(parseStudioDurableFileTransactionReceipt).sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  let reconciled = 0;
  for (const receipt of receipts) {
    const history = historyInputFromReceipt(receipt);
    try {
      await input.recordDurableEdit(history);
    } catch (error) {
      throw new DurableStudioHistoryPendingError(receipt.id, error);
    }
    await acknowledge(root, receipt.id, fetchImpl);
    reconciled += 1;
  }
  return { reconciled };
}
