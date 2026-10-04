import { useCallback, useRef } from "react";
import type { TimelineElement } from "../../player/index";
import { usePlayerStore } from "../../player/index";
import type { DomEditSelection } from "./domEditing";
import { type ClipboardPayload, deduplicateIds, insertAsSibling } from "./clipboardPayload";
import { collectHtmlIds } from "../../lib/studioHelpers";
import { insertTimelineAssetIntoSource } from "../timeline/timelineAssetDrop";
import { saveProjectFilesWithHistory } from "../history/studioFileHistory";
import type { EditHistoryKind } from "../history/editHistory";
import { formatTimelineAttributeNumber } from "../../player/components/timelineEditing";
import { findElementForSelection } from "./domEditingElement";
import { readFileContent } from "../timeline/timelineEditingHelpers";
import { captureNativeClipboard, pasteNativeClipboard, type NativeClipboardSnapshot } from "./nativeClipboard";
import type { UseProjectAnimatedPropertyCommitOptions } from "../animation/useProjectAnimatedPropertyCommit";
import { trackStudioPendingEdit } from "../history/studioPendingEdits";

interface RecordEditInput {
  label: string;
  kind: EditHistoryKind;
  coalesceKey?: string;
  files: Record<string, { before: string; after: string }>;
}

interface UseClipboardOptions {
  projectId: string | null;
  activeCompPath: string | null;
  domEditSelectionRef: React.MutableRefObject<DomEditSelection | null>;
  showToast: (message: string, tone?: "error" | "info") => void;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  domEditSaveTimestampRef: React.MutableRefObject<number>;
  reloadPreview: () => void;
  handleTimelineElementDelete: (element: TimelineElement) => Promise<void>;
  handleDomEditElementDelete: (selection: DomEditSelection) => Promise<void>;
  previewIframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  nativeProjectEditing?: Omit<UseProjectAnimatedPropertyCommitOptions, "legacyCommitProperties">;
}

function getElementOuterHtml(
  iframeRef: React.MutableRefObject<HTMLIFrameElement | null>,
  selection: DomEditSelection,
  activeCompositionPath: string | null,
): string | null {
  let doc: Document | null = null;
  try {
    doc = iframeRef.current?.contentDocument ?? null;
  } catch {
    return null;
  }
  if (!doc) return null;

  return findElementForSelection(doc, selection, activeCompositionPath)?.outerHTML ?? null;
}

export function useClipboard({
  projectId,
  activeCompPath,
  domEditSelectionRef,
  showToast,
  writeProjectFile,
  recordEdit,
  domEditSaveTimestampRef,
  reloadPreview,
  handleTimelineElementDelete,
  handleDomEditElementDelete,
  previewIframeRef,
  nativeProjectEditing,
}: UseClipboardOptions) {
  const clipboardRef = useRef<(ClipboardPayload & { native?: NativeClipboardSnapshot }) | null>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const capture = useCallback((payload: ClipboardPayload): boolean => {
    try {
      const native = captureNativeClipboard(payload.html, nativeProjectEditing?.nativeDocument ?? null, projectIdRef.current);
      if (nativeProjectEditing?.nativeDocument && payload.kind === "timeline-clip" && !native) throw new Error("The clip is not bound to the current native project; reload the composition before copying it");
      clipboardRef.current = { ...payload, native };
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to copy this selection", "error");
      return false;
    }
  }, [nativeProjectEditing, showToast]);

  // fallow-ignore-next-line complexity
  const handleCopy = useCallback((silent = false): boolean => {
    const { selectedElementId, selectedElementIds, elements } = usePlayerStore.getState();
    const selectedKey = selectedElementIds.size === 1
      ? selectedElementIds.values().next().value ?? selectedElementId
      : selectedElementId;

    // Timeline clip copy
    if (selectedKey) {
      const element = elements.find((el) => (el.key ?? el.id) === selectedKey);
      if (!element) return false;
      const targetPath = element.sourceFile || activeCompPath || "index.html";

      let html: string | null = null;
      try {
        const doc = previewIframeRef.current?.contentDocument;
        if (doc) {
          html =
            findElementForSelection(
              doc,
              {
                hfId: element.hfId,
                id: element.domId,
                selector: element.selector,
                selectorIndex: element.selectorIndex,
                sourceFile: targetPath,
              },
              activeCompPath,
            )?.outerHTML ?? null;
        }
      } catch {
        // cross-origin frame
      }

      if (!html) {
        showToast("Unable to copy this element.", "info");
        return false;
      }

      const payload: ClipboardPayload = { kind: "timeline-clip", html, sourceFile: targetPath };
      if (!capture(payload)) return false;
      if (!silent) showToast("Copied clip", "info");
      return true;
    }

    // DOM element copy
    const domSelection = domEditSelectionRef.current;
    if (domSelection) {
      const html = getElementOuterHtml(previewIframeRef, domSelection, activeCompPath);
      if (!html) {
        showToast("Unable to copy this element.", "info");
        return false;
      }
      const targetPath = domSelection.sourceFile || activeCompPath || "index.html";
      const payload: ClipboardPayload = {
        kind: "dom-element",
        html,
        sourceFile: targetPath,
        originSelector: domSelection.selector,
        originSelectorIndex: domSelection.selectorIndex,
      };
      if (!capture(payload)) return false;
      if (!silent) showToast("Copied element", "info");
      return true;
    }

    return false;
  }, [activeCompPath, domEditSelectionRef, previewIframeRef, showToast, capture]);

  const handlePaste = useCallback(async (placementTime?: number) => {
    const payload = clipboardRef.current;
    if (!payload) {
      showToast("Nothing to paste.", "info");
      return;
    }
    const pid = projectIdRef.current;
    if (!pid) return;

    const targetPath = activeCompPath || "index.html";
    try {
      if (payload.native) {
        if (!nativeProjectEditing) throw new Error("The native project is not ready for paste");
        const operation = pasteNativeClipboard({ payload, snapshot: payload.native, workspaceProjectId: pid, targetPath, playhead: placementTime ?? usePlayerStore.getState().currentTime, editing: nativeProjectEditing, recordEdit });
        trackStudioPendingEdit(operation);
        await operation;
        if (projectIdRef.current !== pid) return;
        domEditSaveTimestampRef.current = Date.now();
        reloadPreview();
        showToast(payload.kind === "timeline-clip" ? "Pasted clip" : "Pasted element", "info");
        return;
      }
      const originalContent = await readFileContent(pid, targetPath);
      const existingIds = collectHtmlIds(originalContent);
      const deduped = deduplicateIds(payload.html, existingIds);

      let patchedContent: string;
      if (payload.kind === "timeline-clip") {
        // Only rewrite data-start on the outermost opening tag. The non-global
        // regex matches the first occurrence, which is always in the root tag
        // since outerHTML starts with it. Nested clips keep their own timing.
        const currentTime = placementTime ?? usePlayerStore.getState().currentTime;
        const rootTagEnd = deduped.indexOf(">");
        const rootTag = rootTagEnd >= 0 ? deduped.slice(0, rootTagEnd + 1) : deduped;
        const patchedRootTag = rootTag.replace(
          /data-start="[^"]*"/,
          `data-start="${formatTimelineAttributeNumber(currentTime)}"`,
        );
        const withNewStart = patchedRootTag + deduped.slice(rootTagEnd + 1);
        patchedContent = insertTimelineAssetIntoSource(originalContent, withNewStart);
      } else {
        patchedContent = insertAsSibling(
          originalContent,
          deduped,
          payload.originSelector,
          payload.originSelectorIndex,
        );
      }

      domEditSaveTimestampRef.current = Date.now();
      await saveProjectFilesWithHistory({
        projectId: pid,
        label: payload.kind === "timeline-clip" ? "Paste clip" : "Paste element",
        kind: "timeline" as EditHistoryKind,
        files: { [targetPath]: patchedContent },
        readFile: async () => originalContent,
        writeFile: writeProjectFile,
        recordEdit,
      });

      reloadPreview();
      showToast(payload.kind === "timeline-clip" ? "Pasted clip" : "Pasted element", "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to paste";
      showToast(message);
    }
  }, [
    activeCompPath,
    domEditSaveTimestampRef,
    recordEdit,
    reloadPreview,
    showToast,
    writeProjectFile,
    nativeProjectEditing,
  ]);

  const handleDuplicate = useCallback((): boolean => {
    const { selectedElementId, selectedElementIds, elements } = usePlayerStore.getState();
    if (selectedElementIds.size > 1) {
      showToast("Duplicate one selected clip at a time.", "info");
      return false;
    }
    const selectedKey = selectedElementIds.size === 1
      ? selectedElementIds.values().next().value ?? selectedElementId
      : selectedElementId;
    const selected = elements.find((element) => (element.key ?? element.id) === selectedKey);
    const previousClipboard = clipboardRef.current;
    if (!handleCopy(true)) return false;
    // Paste captures the payload before its first await. Restore the user's
    // copy buffer so Duplicate leaves later Cmd+V behavior unchanged.
    void handlePaste(selected ? selected.start + selected.duration : undefined);
    clipboardRef.current = previousClipboard;
    return true;
  }, [handleCopy, handlePaste, showToast]);

  const handleCut = useCallback(async (): Promise<boolean> => {
    const copied = handleCopy();
    if (!copied) return false;

    const { selectedElementId, elements } = usePlayerStore.getState();
    if (selectedElementId) {
      const element = elements.find((el) => (el.key ?? el.id) === selectedElementId);
      if (element) {
        await handleTimelineElementDelete(element);
        return true;
      }
    }

    const domSelection = domEditSelectionRef.current;
    if (domSelection) {
      await handleDomEditElementDelete(domSelection);
      return true;
    }
    return true;
  }, [handleCopy, domEditSelectionRef, handleTimelineElementDelete, handleDomEditElementDelete]);

  return { handleCopy, handlePaste, handleCut, handleDuplicate };
}
