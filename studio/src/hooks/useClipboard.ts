import { useCallback, useRef } from "react";
import { useNativeKeyframeClipboard } from "./useNativeKeyframeClipboard";
import { useAuthoredTimelineClipboard } from "./useAuthoredTimelineClipboard";
import type { NativeTimelineEditingDependencies } from "./useTimelineEditingTypes";
import type { TimelineElement } from "../player";
import { usePlayerStore } from "../player";
import type { DomEditSelection } from "../components/editor/domEditing";
import { type ClipboardPayload, deduplicateIds, insertAsSibling } from "../utils/clipboardPayload";
import { collectHtmlIds } from "../utils/studioHelpers";
import { insertTimelineAssetIntoSource } from "../utils/timelineAssetDrop";
import { saveProjectFilesWithHistory } from "../utils/studioFileHistory";
import type { EditHistoryKind } from "../utils/editHistory";
import { formatTimelineAttributeNumber } from "../player/components/timelineEditing";
import { findElementForSelection } from "../components/editor/domEditingElement";
import { readFileContent } from "./timelineEditingHelpers";

interface RecordEditInput {
  label: string;
  kind: EditHistoryKind;
  coalesceKey?: string;
  files: Record<string, { before: string; after: string }>;
}

interface UseClipboardOptions {
  clearCanvasSelection?: () => void;
  nativeProjectEditing?: NativeTimelineEditingDependencies;
  handleTimelineElementsDelete?: (elements: TimelineElement[]) => Promise<void>;
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
  clearCanvasSelection,
  nativeProjectEditing,
  handleTimelineElementsDelete,
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
}: UseClipboardOptions) {
  const keyframeClipboard = useNativeKeyframeClipboard({
    projectId,
    nativeProjectEditing,
    writeProjectFile,
    recordEdit,
    showToast,
  });
  const timelineClipboard = useAuthoredTimelineClipboard({
    clearCanvasSelection,
    projectId,
    activeCompPath,
    showToast,
    writeProjectFile,
    recordEdit,
    domEditSaveTimestampRef,
    reloadPreview,
    nativeProjectEditing,
    handleTimelineElementsDelete,
  });
  const clipboardRef = useRef<ClipboardPayload | null>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  // The copy-mode branches predate this change; this diff only replaces its
  // duplicated DOM lookup with the canonical composition-aware resolver.
  // fallow-ignore-next-line complexity
  const handleCopy = useCallback((): boolean => {
    if (keyframeClipboard.copy()) {
      clipboardRef.current = null;
      return true;
    }

    if (timelineClipboard.copy()) {
      keyframeClipboard.clear();
      clipboardRef.current = null;
      return true;
    }

    keyframeClipboard.clear();
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
      clipboardRef.current = payload;
      showToast("Copied element", "info");
      return true;
    }

    return false;
  }, [
    activeCompPath,
    domEditSelectionRef,
    previewIframeRef,
    showToast,
    timelineClipboard.copy,
    keyframeClipboard.copy,
    keyframeClipboard.clear,
  ]);

  const handlePaste = useCallback(async () => {
    const invokedTime = usePlayerStore.getState().currentTime;
    if (await keyframeClipboard.paste()) return;
    const payload = clipboardRef.current;
    if (!payload && (await timelineClipboard.paste(invokedTime))) return;
    if (!payload) {
      showToast("Nothing to paste.", "info");
      return;
    }
    const pid = projectIdRef.current;
    if (!pid) return;

    const targetPath = activeCompPath || "index.html";
    try {
      const originalContent = await readFileContent(pid, targetPath);
      const existingIds = collectHtmlIds(originalContent);
      const deduped = deduplicateIds(payload.html, existingIds);

      let patchedContent: string;
      if (payload.kind === "timeline-clip") {
        // Only rewrite data-start on the outermost opening tag. The non-global
        // regex matches the first occurrence, which is always in the root tag
        // since outerHTML starts with it. Nested clips keep their own timing.
        const { currentTime } = usePlayerStore.getState();
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
    timelineClipboard.paste,
    keyframeClipboard.paste,
  ]);

  const handleCut = useCallback(async (): Promise<boolean> => {
    if (usePlayerStore.getState().selectedKeyframes.size) return keyframeClipboard.cut();
    keyframeClipboard.clear();
    if (
      usePlayerStore.getState().selectedElementId ||
      usePlayerStore.getState().selectedElementIds.size
    ) {
      clipboardRef.current = null;
      return timelineClipboard.cut();
    }
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
  }, [
    handleCopy,
    domEditSelectionRef,
    handleTimelineElementDelete,
    handleDomEditElementDelete,
    timelineClipboard.cut,
    keyframeClipboard.cut,
    keyframeClipboard.clear,
  ]);

  const handleDuplicate = useCallback(async () => {
    if (usePlayerStore.getState().selectedKeyframes.size) {
      keyframeClipboard.copy();
      await keyframeClipboard.paste();
      return;
    }
    await timelineClipboard.duplicate();
  }, [keyframeClipboard.copy, keyframeClipboard.paste, timelineClipboard.duplicate]);

  return { handleCopy, handlePaste, handleCut, handleDuplicate };
}
