import { useCallback } from "react";
import { useNativeProjectKeyframeCommands } from "../animation/Keyframe/useNativeProjectKeyframeCommands";
import { createNativeProjectRepository } from "../project/nativeProjectPersistence";
import type { NativeKeyframeProjectCommit } from "../../player/components/deleteSelectedKeyframes";
import { applyNativeProjectPropertyCommand } from "../../../shared/project/nativeProjectPropertyCommands";
import type { NativeMotionPath } from "../../../shared/project/nativeKeyframeTypes";
import { POSITION_PARAMETER_ID } from "../../../shared/project/nativePositionTrack";
import type { UseDomEditSessionParams } from "./useDomEditSession";

/** A clip's position-wide motion change: segment path shapes and/or auto-rotate. */
export interface NativePositionPathChange {
  readonly clip: { readonly sequenceId: string; readonly trackId: string; readonly clipId: string };
  readonly segments?: readonly { readonly frame: number; readonly path: NativeMotionPath | null }[];
  readonly autoRotate?: boolean;
}

const noNativeProjectRead = async (): Promise<null> => null;
const noNativeProjectWrite = async (): Promise<void> => {
  throw new Error("Native project persistence is unavailable");
};

/** Native keyframes and arc edits share one revision-checked project commit. */
export function useNativeProjectEditActions({
  nativeProjectEditing, showToast,
}: Pick<UseDomEditSessionParams, "nativeProjectEditing" | "showToast">) {
  const nativeKeyframeCommands = useNativeProjectKeyframeCommands({
    nativeDocument: nativeProjectEditing?.nativeDocument ?? null,
    readOptionalProjectFile:
      nativeProjectEditing?.readOptionalProjectFile ?? noNativeProjectRead,
    writeProjectFile: nativeProjectEditing?.writeProjectFile ?? noNativeProjectWrite,
    recordHistory: nativeProjectEditing?.recordHistory,
    commitFileTransaction: nativeProjectEditing?.commitFileTransaction,
    onNativeDocumentCommitted: nativeProjectEditing?.onNativeDocumentCommitted,
  });
  const commitNativeProject = useCallback(
    async (commit: NativeKeyframeProjectCommit): Promise<boolean> => {
      const editing = nativeProjectEditing;
      const document = editing?.nativeDocument ?? editing?.nativeBootstrapDocument;
      if (!editing || !document || commit.document.id !== document.id) return false;
      try {
        const repository = createNativeProjectRepository({
          readOptionalProjectFile: editing.readOptionalProjectFile,
          writeProjectFile: editing.writeProjectFile,
          recordHistory: editing.recordHistory,
          commitFileTransaction: editing.commitFileTransaction,
        });
        const committed = await repository.save(commit.document, {
          expectedRevision: editing.nativeDocument?.revision ?? null,
          label: commit.label,
        });
        editing.onNativeDocumentCommitted?.(committed.document);
        return true;
      } catch {
        return false;
      }
    },
    [nativeProjectEditing],
  );
  // Arc motion: applied to the authoritative document (or the bootstrap
  // candidate on a project's first native edit) and saved with history.
  const setNativePositionPath = useCallback(
    async (change: NativePositionPathChange): Promise<void> => {
      const editing = nativeProjectEditing;
      const document = editing?.nativeDocument ?? editing?.nativeBootstrapDocument;
      if (!document) return;
      const address = { ...change.clip, parameterId: POSITION_PARAMETER_ID };
      const result = applyNativeProjectPropertyCommand(document, {
        type: "batch",
        commands: [
          ...(change.segments ?? []).map((segment) => ({
            type: "set-motion-path" as const,
            address,
            frame: segment.frame,
            path: segment.path,
          })),
          ...(change.autoRotate === undefined
            ? []
            : [{ type: "set-auto-rotate" as const, address, autoRotate: change.autoRotate }]),
        ],
      });
      if (!result.ok) {
        showToast(result.failure.message, "error");
        return;
      }
      const saved = await commitNativeProject({
        document: result.document,
        inverse: { type: "restore-document", document },
        label: change.autoRotate === undefined ? "Change motion path" : "Change auto-rotate",
      });
      if (!saved) showToast("The motion path could not be saved", "error");
    },
    [commitNativeProject, nativeProjectEditing, showToast],
  );
  return { nativeKeyframeCommands, commitNativeProject, setNativePositionPath };
}
