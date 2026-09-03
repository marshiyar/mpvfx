import type { DurableRecordEditInput } from "../hooks/usePersistentEditHistory";
import type { EditHistoryKind } from "./editHistory";
import { createStudioWriteToken, markStudioWriteToken } from "./studioFileVersion";

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
  history?: StudioDurableFileTransactionHistory;
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
    throw new Error(message);
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

function parseReceipt(value: unknown): StudioDurableFileTransactionReceipt {
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
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error(`Durable transaction ${id} has no file snapshots`);
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
  return {
    id,
    state: "COMMITTED",
    sequence: Number(sequence),
    files,
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
  if (!receipt.history) {
    throw new Error(`Durable transaction ${receipt.id} is missing Undo history metadata`);
  }
  const files: DurableRecordEditInput["files"] = {};
  for (const file of receipt.files) {
    // The existing optional-file API represents absence as empty bytes on
    // Undo. Native project loading treats an empty sidecar as absent, so this
    // preserves the user-visible creation/deletion boundary while keeping the
    // history schema backwards compatible.
    files[file.path] = { before: file.expectedBefore ?? "", after: file.after ?? "" };
  }
  return {
    ...receipt.history,
    durableTransactionIds: [receipt.id],
    files,
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

export async function commitDurableStudioFileTransaction(
  input: CommitDurableStudioFileTransactionInput,
): Promise<StudioDurableFileTransactionReceipt> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const root = apiRoot(input.projectId);
  const id = input.transactionId ?? (input.createTransactionId ?? defaultTransactionId)();
  const writeTokens = Object.fromEntries(
    input.files.map((file) => {
      const token = createStudioWriteToken();
      markStudioWriteToken(token);
      return [file.path, token];
    }),
  );
  const response = await fetchImpl(`${root}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, files: input.files, history: input.history, writeTokens }),
  });
  const receipt = parseReceipt(await responseJson(response));
  if (receipt.id !== id) {
    throw new Error(`Durable transaction receipt id ${receipt.id} does not match ${id}`);
  }
  try {
    await input.recordDurableEdit(historyInputFromReceipt(receipt));
  } catch (error) {
    throw new DurableStudioHistoryPendingError(receipt.id, error);
  }
  await acknowledge(root, receipt.id, fetchImpl);
  return receipt;
}

export async function reconcileDurableStudioFileTransactions(
  input: DurableFileTransactionClientDependencies,
): Promise<{ reconciled: number }> {
  const fetchImpl = input.fetchImpl ?? fetch;
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
  const receipts = rawReceipts.map(parseReceipt).sort(
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
