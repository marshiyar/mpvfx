import { useCallback, useRef } from "react";

import {
  type NativeProjectKeyframeFailure,
  type NativeProjectParameterAddress,
} from "../project/nativeProjectKeyframeCommands";
import {
  applyNativeProjectPropertyCommand,
  type NativeProjectAtomicPropertyCommand,
} from "../project/nativeProjectPropertyCommands";
import type { NativeInterpolation } from "../project/nativeKeyframeTypes";
import type { NativeProjectDocument } from "../project/nativeProjectDocument";
import {
  createNativeProjectRepository,
  NativeProjectRevisionConflictError,
  type NativeProjectHistoryEntry,
} from "../project/nativeProjectPersistence";
import { synchronizeIncomingNativeDocument } from "../project/nativeDocumentRefSync";
import type { CommitNativeTimelineFileTransaction } from "../project/nativeTimelineTransactionCommit";

export interface NativeProjectKeyframeTarget extends NativeProjectParameterAddress {
  readonly frame: number;
}

export interface UseNativeProjectKeyframeCommandsOptions {
  readonly nativeDocument: NativeProjectDocument | null;
  readonly readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  readonly writeProjectFile: (
    path: string,
    content: string,
    expectedContent?: string,
  ) => Promise<void>;
  readonly recordHistory?: (entry: NativeProjectHistoryEntry) => Promise<void> | void;
  readonly commitFileTransaction?: CommitNativeTimelineFileTransaction;
  readonly onNativeDocumentCommitted?: (document: NativeProjectDocument) => void;
}

export interface NativeProjectKeyframeCommandApi {
  deleteKeyframe(target: NativeProjectKeyframeTarget): Promise<void>;
  deleteKeyframes(targets: readonly NativeProjectKeyframeTarget[]): Promise<void>;
  deleteAllKeyframes(
    target: NativeProjectKeyframeTarget | readonly NativeProjectKeyframeTarget[],
  ): Promise<void>;
  moveKeyframe(target: NativeProjectKeyframeTarget, toFrame: number): Promise<void>;
  moveKeyframes(
    targets: readonly NativeProjectKeyframeTarget[],
    toFrame: number,
  ): Promise<void>;
  setKeyframeInterpolation(
    target: NativeProjectKeyframeTarget,
    outgoing: NativeInterpolation,
  ): Promise<void>;
  setKeyframesInterpolation(
    targets: readonly NativeProjectKeyframeTarget[],
    outgoing: NativeInterpolation,
  ): Promise<void>;
}

export class NativeProjectKeyframeCommandError extends Error {
  readonly failure: NativeProjectKeyframeFailure | null;

  constructor(message: string, failure: NativeProjectKeyframeFailure | null = null) {
    super(message);
    this.name = "NativeProjectKeyframeCommandError";
    this.failure = failure;
  }
}

const addressOf = (target: NativeProjectKeyframeTarget): NativeProjectParameterAddress => ({
  sequenceId: target.sequenceId,
  trackId: target.trackId,
  clipId: target.clipId,
  parameterId: target.parameterId,
});

/** Revision-safe native keyframe lifecycle commands used by panel and timeline UI. */
export function useNativeProjectKeyframeCommands(
  options: UseNativeProjectKeyframeCommandsOptions,
): NativeProjectKeyframeCommandApi {
  const latestDocumentRef = useRef<NativeProjectDocument | null>(options.nativeDocument);
  const incomingDocumentRef = useRef<NativeProjectDocument | null>(options.nativeDocument);
  synchronizeIncomingNativeDocument(
    incomingDocumentRef,
    latestDocumentRef,
    options.nativeDocument,
  );
  const dependenciesRef = useRef(options);
  dependenciesRef.current = options;
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const execute = useCallback(
    (commands: readonly NativeProjectAtomicPropertyCommand[], label: string): Promise<void> => {
      const run = queueRef.current.then(async () => {
        const document = latestDocumentRef.current;
        if (!document) {
          throw new NativeProjectKeyframeCommandError(
            "No authoritative native project document is available",
          );
        }
        if (commands.length === 0) {
          throw new NativeProjectKeyframeCommandError("At least one native keyframe command is required");
        }
        const dependencies = dependenciesRef.current;
        const repository = createNativeProjectRepository({
          readOptionalProjectFile: dependencies.readOptionalProjectFile,
          writeProjectFile: dependencies.writeProjectFile,
          recordHistory: dependencies.recordHistory,
          commitFileTransaction: dependencies.commitFileTransaction,
        });
        const applyCommands = (draft: NativeProjectDocument): NativeProjectDocument => {
          const result = applyNativeProjectPropertyCommand(draft, {
            type: "batch",
            commands,
          });
          if (!result.ok) {
            throw new NativeProjectKeyframeCommandError(result.failure.message, result.failure);
          }
          return result.document;
        };
        let committed;
        try {
          committed = await repository.transaction(
            { expectedRevision: document.revision, label },
            applyCommands,
          );
        } catch (error) {
          if (!(error instanceof NativeProjectRevisionConflictError)) throw error;
          const latest = await repository.load();
          if (!latest || latest.document.id !== document.id) throw error;
          latestDocumentRef.current = latest.document;
          committed = await repository.transaction(
            { expectedRevision: latest.document.revision, label },
            applyCommands,
          );
        }
        latestDocumentRef.current = committed.document;
        dependencies.onNativeDocumentCommitted?.(committed.document);
      });
      queueRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [],
  );

  const deleteKeyframes = useCallback(
    (targets: readonly NativeProjectKeyframeTarget[]) =>
      execute(
        targets.map((target) => ({
          type: "delete" as const,
          address: addressOf(target),
          frame: target.frame,
        })),
        targets.length === 1 ? "Delete keyframe" : `Delete ${targets.length} keyframes`,
      ),
    [execute],
  );

  const deleteKeyframe = useCallback(
    (target: NativeProjectKeyframeTarget) => deleteKeyframes([target]),
    [deleteKeyframes],
  );

  const moveKeyframes = useCallback(
    (targets: readonly NativeProjectKeyframeTarget[], toFrame: number) =>
      execute(
        targets.map((target) => ({
          type: "move",
          address: addressOf(target),
          fromFrame: target.frame,
          toFrame,
        })),
        targets.length === 1 ? "Move keyframe" : `Move ${targets.length} keyframes`,
      ),
    [execute],
  );

  const moveKeyframe = useCallback(
    (target: NativeProjectKeyframeTarget, toFrame: number) => moveKeyframes([target], toFrame),
    [moveKeyframes],
  );

  const deleteAllKeyframes = useCallback(
    (targetOrTargets: NativeProjectKeyframeTarget | readonly NativeProjectKeyframeTarget[]) => {
      const targets = Array.isArray(targetOrTargets) ? targetOrTargets : [targetOrTargets];
      return (
      execute(
        targets.map((target) => ({
          type: "collapse-track",
          address: addressOf(target),
          frame: target.frame,
        })),
        targets.length === 1
          ? "Delete all keyframes"
          : `Delete all keyframes from ${targets.length} parameters`,
      )
      );
    },
    [execute],
  );

  const setKeyframesInterpolation = useCallback(
    (targets: readonly NativeProjectKeyframeTarget[], outgoing: NativeInterpolation) =>
      execute(
        targets.map((target) => ({
          type: "set-outgoing",
          address: addressOf(target),
          frame: target.frame,
          outgoing,
        })),
        targets.length === 1
          ? "Change keyframe interpolation"
          : `Change ${targets.length} keyframe interpolations`,
      ),
    [execute],
  );

  const setKeyframeInterpolation = useCallback(
    (target: NativeProjectKeyframeTarget, outgoing: NativeInterpolation) =>
      setKeyframesInterpolation([target], outgoing),
    [setKeyframesInterpolation],
  );

  return {
    deleteKeyframe,
    deleteKeyframes,
    deleteAllKeyframes,
    moveKeyframe,
    moveKeyframes,
    setKeyframeInterpolation,
    setKeyframesInterpolation,
  };
}
