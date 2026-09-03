import {
  NATIVE_PROJECT_DOCUMENT_PATH,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { serializeStudioFileMutation } from "../utils/studioFileMutationCoordinator";
import type { CommitNativeTimelineFileTransaction } from "./nativeTimelineTransactionCommit";

export interface NativeProjectHistoryEntry {
  readonly path: typeof NATIVE_PROJECT_DOCUMENT_PATH;
  readonly before: string | null;
  readonly after: string;
  readonly label: string;
  readonly kind: "save" | "transaction";
}

export interface NativeProjectPersistenceDependencies {
  readonly readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  readonly writeProjectFile: (
    path: string,
    content: string,
    expectedContent?: string,
  ) => Promise<void>;
  readonly recordHistory?: (entry: NativeProjectHistoryEntry) => Promise<void> | void;
  readonly commitFileTransaction?: CommitNativeTimelineFileTransaction;
}

export interface NativeProjectLoadOptions {
  readonly signal?: AbortSignal;
}

export interface NativeProjectCommitOptions extends NativeProjectLoadOptions {
  /** `null` asserts that no non-empty project document exists yet. */
  readonly expectedRevision: number | null;
  readonly label?: string;
}

export interface NativeProjectLoadResult {
  readonly document: NativeProjectDocument;
  /** Exact bytes read, retained for optimistic compare-and-swap. */
  readonly content: string;
}

export interface NativeProjectCommitResult extends NativeProjectLoadResult {
  readonly path: typeof NATIVE_PROJECT_DOCUMENT_PATH;
}

export type NativeProjectTransaction = (
  draft: NativeProjectDocument,
) => NativeProjectDocument | void | Promise<NativeProjectDocument | void>;

export interface NativeProjectRepository {
  load(options?: NativeProjectLoadOptions): Promise<NativeProjectLoadResult | null>;
  save(document: unknown, options: NativeProjectCommitOptions): Promise<NativeProjectCommitResult>;
  transaction(
    options: NativeProjectCommitOptions,
    update: NativeProjectTransaction,
  ): Promise<NativeProjectCommitResult>;
}

export class NativeProjectRevisionConflictError extends Error {
  readonly expectedRevision: number | null;
  readonly actualRevision: number | null;

  constructor(expectedRevision: number | null, actualRevision: number | null) {
    super(
      `Project revision conflict: expected ${String(expectedRevision)}, found ${String(actualRevision)}`,
    );
    this.name = "NativeProjectRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

interface ReadState {
  readonly document: NativeProjectDocument | null;
  readonly content: string | null;
  readonly expectedContent: string | undefined;
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The project operation was aborted", "AbortError");
};

const cloneDocument = (document: NativeProjectDocument): NativeProjectDocument =>
  parseNativeProjectDocument(JSON.parse(serializeNativeProjectDocument(document)));

export const createNativeProjectRepository = (
  dependencies: NativeProjectPersistenceDependencies,
): NativeProjectRepository => {
  const readState = async (signal?: AbortSignal): Promise<ReadState> => {
    throwIfAborted(signal);
    const rawContent = await dependencies.readOptionalProjectFile(NATIVE_PROJECT_DOCUMENT_PATH);
    throwIfAborted(signal);
    if (rawContent == null || rawContent.trim().length === 0) {
      return {
        document: null,
        content: null,
        expectedContent: typeof rawContent === "string" ? rawContent : undefined,
      };
    }
    const document = parseNativeProjectDocument(JSON.parse(rawContent));
    return { document, content: rawContent, expectedContent: rawContent };
  };

  const assertExpectedRevision = (
    state: ReadState,
    expectedRevision: number | null,
  ): void => {
    const actualRevision = state.document?.revision ?? null;
    if (actualRevision !== expectedRevision) {
      throw new NativeProjectRevisionConflictError(expectedRevision, actualRevision);
    }
  };

  const commit = async (
    state: ReadState,
    candidate: unknown,
    options: NativeProjectCommitOptions,
    kind: NativeProjectHistoryEntry["kind"],
  ): Promise<NativeProjectCommitResult> => {
    assertExpectedRevision(state, options.expectedRevision);
    const validatedCandidate = parseNativeProjectDocument(candidate);
    const revision = state.document ? state.document.revision + 1 : 0;
    const document = parseNativeProjectDocument({ ...validatedCandidate, revision });
    const content = serializeNativeProjectDocument(document);
    throwIfAborted(options.signal);
    const label = options.label ?? (kind === "save" ? "Save project" : "Edit project");
    if (dependencies.commitFileTransaction) {
      await dependencies.commitFileTransaction({
        files: [
          {
            path: NATIVE_PROJECT_DOCUMENT_PATH,
            expectedBefore: state.content ?? state.expectedContent ?? null,
            after: content,
          },
        ],
        history: { label, kind: "motion" },
      });
      return { path: NATIVE_PROJECT_DOCUMENT_PATH, document, content };
    }
    await dependencies.writeProjectFile(
      NATIVE_PROJECT_DOCUMENT_PATH,
      content,
      state.expectedContent,
    );

    try {
      if (dependencies.recordHistory) {
        await dependencies.recordHistory({
          path: NATIVE_PROJECT_DOCUMENT_PATH,
          before: state.content,
          after: content,
          label,
          kind,
        });
      }
    } catch (error) {
      try {
        // A history entry and its bytes are one durable editor operation. If
        // history registration fails, restore only the bytes this commit wrote
        // and require them as the CAS expectation so unrelated work is never
        // overwritten during rollback.
        await dependencies.writeProjectFile(
          NATIVE_PROJECT_DOCUMENT_PATH,
          state.content ?? state.expectedContent ?? "",
          content,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Native project history failed and project rollback did not complete",
        );
      }
      throw error;
    }
    return { path: NATIVE_PROJECT_DOCUMENT_PATH, document, content };
  };

  const runSerialized = <T>(operation: () => Promise<T>): Promise<T> =>
    serializeStudioFileMutation(
      dependencies.writeProjectFile,
      NATIVE_PROJECT_DOCUMENT_PATH,
      operation,
    );

  return {
    load: (options = {}) =>
      runSerialized(async () => {
        const state = await readState(options.signal);
        if (!state.document || state.content == null) return null;
        return { document: state.document, content: state.content };
      }),

    save: (document, options) =>
      runSerialized(async () => {
        const state = await readState(options.signal);
        return commit(state, document, options, "save");
      }),

    transaction: (options, update) =>
      runSerialized(async () => {
        const state = await readState(options.signal);
        assertExpectedRevision(state, options.expectedRevision);
        if (!state.document) {
          throw new NativeProjectRevisionConflictError(options.expectedRevision, null);
        }
        const draft = cloneDocument(state.document);
        const updated = await update(draft);
        throwIfAborted(options.signal);
        return commit(state, updated ?? draft, options, "transaction");
      }),
  };
};
