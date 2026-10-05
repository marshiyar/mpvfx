import { useCallback } from "react";
import { PREVIEW_GSAP_CHANNELS, type PreviewElementState, type PreviewGsapChannel } from "../../../shared/preview/agentProtocol";
import type { PreviewAgentCommand } from "../../../shared/preview/agentProtocol";
import type { PatchOperation } from "../legacy/sourcePatcher";
import { commitRemoteInspectorSourcePatch, commitRemoteLegacyInspectorSourcePatch,
  commitRemoteLegacyGradePreset } from "./remoteInspectorSourceTransaction";
import { commitRemoteStackingBatch, type RemoteStackingEntry } from "./remoteStackingBatchTransaction";
import { commitRemoteGsapAnimationAction, commitRemoteGsapKeyframeEdit, commitRemoteGsapPropertyEdit,
  loadRemoteGsapTargets, type RemoteGsapTarget } from "../animation/GSAP/remoteGsapSourceTransaction";
import { isPreviewElementState, previewAgentForIframe } from "../preview/previewAgentClient";
import { commitRemoteGsapGesture, type RemoteGsapGesture } from "../animation/GSAP/remoteGsapGestureTransaction";
import { commitRemoteNativeMediaEdit, type RemoteNativeMediaCommand } from "../project/remoteInspectorNativeMediaTransaction";
import type { UseDomEditSessionParams } from "./useDomEditSession";

type RemoteSourceEditParams = Pick<UseDomEditSessionParams,
  "projectId" | "activeCompPath" | "previewIframeRef" | "nativeProjectEditing" |
  "readProjectFile" | "writeProjectFile" | "editHistory" | "domEditSaveTimestampRef" |
  "reloadPreview" | "showToast">;

/** Durable isolated-frame source edits and bounded authored animation controls. */
export function useRemoteSourceEdits({
  projectId, activeCompPath, previewIframeRef, nativeProjectEditing,
  readProjectFile, writeProjectFile, editHistory, domEditSaveTimestampRef,
  reloadPreview, showToast,
}: RemoteSourceEditParams) {
  const commitRemoteInspectorEdit = useCallback(async (
    state: PreviewElementState, operations: PatchOperation[] | "reset-design", label: string,
  ): Promise<boolean> => {
    const editing = nativeProjectEditing;
    if (!projectId) return false;
    try {
      const deps = {
        readOptionalProjectFile: editing?.readOptionalProjectFile ?? (async (path: string) => {
          try { return await readProjectFile(path); } catch { return null; }
        }),
        writeProjectFile: editing?.writeProjectFile ?? writeProjectFile,
        recordEdit: editHistory.recordEdit,
        commitFileTransaction: editing?.commitFileTransaction,
      };
      const saved = editing?.nativeDocument
        ? await commitRemoteInspectorSourcePatch(state, operations, label, deps)
        : await commitRemoteLegacyInspectorSourcePatch(state, operations, label,
          activeCompPath ?? "index.html", deps);
      if (!saved) return false;
      domEditSaveTimestampRef.current = Date.now();
      const client = previewAgentForIframe(previewIframeRef.current);
      type LiveCommand = Extract<PreviewAgentCommand, { kind: "setStyle" | "setText" | "setAttribute" }>;
      const commands: LiveCommand[] | null = operations === "reset-design" ? null
        : operations.map((operation): LiveCommand | null => {
            if (operation.type === "inline-style") return { kind: "setStyle" as const,
              handle: state.handle, property: operation.property, value: operation.value ?? "" };
            if (operation.type === "text-content" && operation.value !== null) return {
              kind: "setText" as const, handle: state.handle, text: operation.value };
            if (operation.type === "html-attribute" && operation.value !== null) return {
              kind: "setAttribute" as const, handle: state.handle,
              name: operation.property, value: operation.value };
            return null;
          }).filter((command): command is LiveCommand => command !== null);
      if (client?.isReady && commands && commands.length === operations.length) {
        try {
          for (const command of commands) await client.request(command);
          window.dispatchEvent(new CustomEvent("mpvfx-isolated-preview-selection", {
            detail: { iframe: previewIframeRef.current, state },
          }));
          return true;
        } catch { /* Reload the source if the bounded live command was refused. */ }
      }
      reloadPreview();
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The inspector edit could not be saved", "error");
      return false;
    }
  }, [activeCompPath, domEditSaveTimestampRef, editHistory.recordEdit, nativeProjectEditing,
    previewIframeRef, projectId, readProjectFile, reloadPreview, showToast, writeProjectFile]);
  const commitRemoteStackingPatches = useCallback(async (
    entries: readonly RemoteStackingEntry[], coalesceKey?: string,
  ): Promise<boolean> => {
    const editing = nativeProjectEditing;
    if (!editing?.nativeDocument || !projectId) return false;
    try {
      const saved = await commitRemoteStackingBatch(entries, coalesceKey, {
        readOptionalProjectFile: editing.readOptionalProjectFile,
        writeProjectFile: editing.writeProjectFile,
        recordEdit: editHistory.recordEdit,
        commitFileTransaction: editing.commitFileTransaction,
      });
      if (saved) {
        domEditSaveTimestampRef.current = Date.now();
        reloadPreview();
      }
      return saved;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The layer order could not be saved", "error");
      return false;
    }
  }, [domEditSaveTimestampRef, editHistory.recordEdit, nativeProjectEditing, projectId, reloadPreview, showToast]);
  const commitRemoteLegacyGrade = useCallback(async (
    state: PreviewElementState, presetId: string | null,
  ): Promise<boolean> => {
    if (!projectId || nativeProjectEditing?.nativeDocument) return false;
    try {
      const saved = await commitRemoteLegacyGradePreset(state, presetId,
        activeCompPath ?? "index.html", {
          readOptionalProjectFile: async path => {
            try { return await readProjectFile(path); } catch { return null; }
          },
          writeProjectFile, recordEdit: editHistory.recordEdit,
          commitFileTransaction: nativeProjectEditing?.commitFileTransaction,
        });
      if (saved) {
        domEditSaveTimestampRef.current = Date.now();
        reloadPreview();
      }
      return saved;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The color grade could not be saved", "error");
      return false;
    }
  }, [activeCompPath, domEditSaveTimestampRef, editHistory.recordEdit, nativeProjectEditing,
    projectId, readProjectFile, reloadPreview, showToast, writeProjectFile]);
  const commitRemoteNativeMedia = useCallback(async (
    state: PreviewElementState, command: RemoteNativeMediaCommand,
  ): Promise<boolean> => {
    const editing = nativeProjectEditing;
    if (!editing?.nativeDocument || !projectId) return false;
    try {
      await commitRemoteNativeMediaEdit(state, command, {
        expectedRevision: editing.nativeDocument.revision,
        readOptionalProjectFile: editing.readOptionalProjectFile,
        writeProjectFile: editing.writeProjectFile,
        recordEdit: editHistory.recordEdit,
        commitFileTransaction: editing.commitFileTransaction,
        onNativeDocumentCommitted: editing.onNativeDocumentCommitted,
      });
      domEditSaveTimestampRef.current = Date.now();
      reloadPreview();
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The media edit could not be saved", "error");
      return false;
    }
  }, [domEditSaveTimestampRef, editHistory.recordEdit, nativeProjectEditing, projectId, reloadPreview, showToast]);
  const loadRemoteGsapAnimations = useCallback(async (
    state: PreviewElementState,
  ): Promise<RemoteGsapTarget[]> => {
    const client = previewAgentForIframe(previewIframeRef.current);
    if (!projectId || !client?.isReady) return [];
    // A root editor URL omits `comp`; its trusted active source is index.html.
    // The transaction still requires the observed element/source to match it.
    const expectedSourceFile = activeCompPath ?? "index.html";
    try {
      const observation = await client.observeGsap(state.handle, [...PREVIEW_GSAP_CHANNELS]);
      return await loadRemoteGsapTargets(state, observation, {
        expectedSourceFile,
        readOptionalProjectFile: async path => {
          try { return await readProjectFile(path); } catch { return null; }
        },
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The authored animations could not be read", "error");
      return [];
    }
  }, [activeCompPath, previewIframeRef, projectId, readProjectFile, showToast]);
  const commitRemoteGsapProperty = useCallback(async (
    state: PreviewElementState,
    edit: { animationId: string; property: PreviewGsapChannel; value: number; endpoint?: "from" | "to" },
  ): Promise<boolean> => {
    const client = previewAgentForIframe(previewIframeRef.current);
    if (!projectId || !client?.isReady) return false;
    const expectedSourceFile = activeCompPath ?? "index.html";
    try {
      const observation = await client.observeGsap(state.handle, [...PREVIEW_GSAP_CHANNELS]);
      const saved = await commitRemoteGsapPropertyEdit(state, observation, edit, {
        expectedSourceFile,
        readOptionalProjectFile: async path => {
          try { return await readProjectFile(path); } catch { return null; }
        },
        writeProjectFile,
        recordEdit: editHistory.recordEdit,
        commitFileTransaction: nativeProjectEditing?.commitFileTransaction,
      });
      if (saved) {
        domEditSaveTimestampRef.current = Date.now();
        reloadPreview();
      }
      return saved;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The authored animation could not be saved", "error");
      return false;
    }
  }, [activeCompPath, domEditSaveTimestampRef, editHistory.recordEdit, nativeProjectEditing,
    previewIframeRef, projectId, readProjectFile, reloadPreview, showToast, writeProjectFile]);
  const commitRemoteGsapKeyframe = useCallback(async (
    state: PreviewElementState, edit: Parameters<typeof commitRemoteGsapKeyframeEdit>[2],
  ): Promise<boolean> => {
    const client = previewAgentForIframe(previewIframeRef.current);
    if (!projectId || !client?.isReady) return false;
    try {
      const observation = await client.observeGsap(state.handle, [...PREVIEW_GSAP_CHANNELS]);
      const saved = await commitRemoteGsapKeyframeEdit(state, observation, edit, {
        expectedSourceFile: activeCompPath ?? "index.html",
        readOptionalProjectFile: async path => {
          try { return await readProjectFile(path); } catch { return null; }
        },
        writeProjectFile,
        recordEdit: editHistory.recordEdit,
        commitFileTransaction: nativeProjectEditing?.commitFileTransaction,
      });
      if (saved) {
        domEditSaveTimestampRef.current = Date.now();
        reloadPreview();
      }
      return saved;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The authored keyframe could not be saved", "error");
      return false;
    }
  }, [activeCompPath, domEditSaveTimestampRef, editHistory.recordEdit, nativeProjectEditing,
    previewIframeRef, projectId, readProjectFile, reloadPreview, showToast, writeProjectFile]);
  const commitRemoteGsapAnimation = useCallback(async (
    state: PreviewElementState, action: Parameters<typeof commitRemoteGsapAnimationAction>[2],
  ): Promise<boolean> => {
    const client = previewAgentForIframe(previewIframeRef.current);
    if (!projectId || !client?.isReady) return false;
    try {
      const observation = await client.observeGsap(state.handle, [...PREVIEW_GSAP_CHANNELS]);
      const saved = await commitRemoteGsapAnimationAction(state, observation, action, {
        expectedSourceFile: activeCompPath ?? "index.html",
        readOptionalProjectFile: async path => {
          try { return await readProjectFile(path); } catch { return null; }
        },
        writeProjectFile,
        recordEdit: editHistory.recordEdit,
        commitFileTransaction: nativeProjectEditing?.commitFileTransaction,
      });
      if (saved) {
        domEditSaveTimestampRef.current = Date.now();
        reloadPreview();
      }
      return saved;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The authored animation could not be saved", "error");
      return false;
    }
  }, [activeCompPath, domEditSaveTimestampRef, editHistory.recordEdit, nativeProjectEditing,
    previewIframeRef, projectId, readProjectFile, reloadPreview, showToast, writeProjectFile]);
  const commitRemoteGsapCanvasGesture = useCallback(async (
    state: PreviewElementState, gesture: RemoteGsapGesture,
  ): Promise<boolean> => {
    const client = previewAgentForIframe(previewIframeRef.current);
    if (!projectId || !client?.isReady) return false;
    try {
      const ancestors: PreviewElementState[] = [];
      const seen = new Set<string>([state.handle]);
      let parent = state.parent;
      while (parent !== null && ancestors.length <= 16) {
        if (seen.has(parent)) throw new Error("The preview parent chain is cyclic");
        seen.add(parent);
        const resolved = await client.request({ kind: "readElement", handle: parent });
        if (!isPreviewElementState(resolved) || resolved.handle !== parent) {
          throw new Error("The preview parent chain is unavailable");
        }
        ancestors.push(resolved);
        parent = resolved.parent;
      }
      if (parent !== null) throw new Error("The preview parent chain is too deep");
      const observation = await client.observeGsap(state.handle, [...PREVIEW_GSAP_CHANNELS]);
      const saved = await commitRemoteGsapGesture(state, observation, ancestors, gesture, {
        expectedSourceFile: activeCompPath ?? "index.html",
        readOptionalProjectFile: async path => {
          try { return await readProjectFile(path); } catch { return null; }
        },
        writeProjectFile,
        recordEdit: editHistory.recordEdit,
        commitFileTransaction: nativeProjectEditing?.commitFileTransaction,
      });
      if (saved) {
        domEditSaveTimestampRef.current = Date.now();
        reloadPreview();
      }
      return saved;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The animated canvas edit could not be saved", "error");
      return false;
    }
  }, [activeCompPath, domEditSaveTimestampRef, editHistory.recordEdit, nativeProjectEditing,
    previewIframeRef, projectId, readProjectFile, reloadPreview, showToast, writeProjectFile]);
  return { commitRemoteInspectorEdit, commitRemoteStackingPatches, commitRemoteNativeMedia,
    commitRemoteLegacyGrade,
    loadRemoteGsapAnimations, commitRemoteGsapProperty, commitRemoteGsapKeyframe,
    commitRemoteGsapAnimation,
    commitRemoteGsapCanvasGesture };
}
