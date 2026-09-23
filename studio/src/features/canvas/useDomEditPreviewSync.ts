/**
 * Side effects for syncing the DOM edit selection with the preview iframe on
 * load/refresh.
 * Extracted from useDomEditSession to keep file sizes under the 600-line limit.
 */
import { useEffect } from "react";
import { findElementForSelection, type DomEditSelection } from "./domEditing";
import { reapplyPositionEditsAfterSeek } from "./manualEdits";
import { logSelect } from "../../lib/selectDebug";

interface UseDomEditPreviewSyncParams {
  previewIframe: HTMLIFrameElement | null;
  activeCompPath: string | null;
  captionEditMode: boolean;
  domEditSelectionRef: React.MutableRefObject<DomEditSelection | null>;
  domEditGroupSelectionsRef: React.MutableRefObject<DomEditSelection[]>;
  domEditSelection: DomEditSelection | null;
  /** Re-resolves a whole multi-selection against the current preview document. */
  refreshDomEditGroupSelectionsFromPreview: (selections: DomEditSelection[]) => Promise<void>;
  applyDomSelection: (
    selection: DomEditSelection | null,
    options?: { revealPanel?: boolean; preserveGroup?: boolean },
  ) => void;
  buildDomSelectionFromTarget: (element: HTMLElement) => Promise<DomEditSelection | null>;
  refreshPreviewDocumentVersion: () => void;
  syncPreviewHotkeys: (iframe: HTMLIFrameElement | null) => void;
  applyStudioManualEditsToPreviewRef: React.MutableRefObject<
    (iframe: HTMLIFrameElement) => Promise<void>
  >;
  gsapCacheVersion?: number;
}

export function useDomEditPreviewSync({
  previewIframe,
  activeCompPath,
  captionEditMode,
  domEditSelectionRef,
  domEditGroupSelectionsRef,
  domEditSelection,
  applyDomSelection,
  refreshDomEditGroupSelectionsFromPreview,
  buildDomSelectionFromTarget,
  refreshPreviewDocumentVersion,
  syncPreviewHotkeys,
  applyStudioManualEditsToPreviewRef,
  gsapCacheVersion,
}: UseDomEditPreviewSyncParams): void {
  // Sync selection from preview document on load / refresh
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!previewIframe) return;
    let cancelled = false;
    let refreshGeneration = 0;

    // fallow-ignore-next-line complexity
    const syncSelectionFromDocument = async () => {
      const generation = ++refreshGeneration;
      if (captionEditMode) return;
      const currentSelection = domEditSelectionRef.current;
      if (!currentSelection) return;
      const currentGroup = domEditGroupSelectionsRef.current;
      let doc: Document | null = null;
      try {
        doc = previewIframe.contentDocument;
      } catch {
        return;
      }
      if (!doc) return;

      reapplyPositionEditsAfterSeek(doc);

      const nextElement = findElementForSelection(doc, currentSelection, activeCompPath);
      if (!nextElement) {
        // The selected element no longer resolves in the (re-synced) document
        // — comp/hot reload, activeCompPath swap, or post-save replacement.
        // Clear so overlay geometry isn't computed on a stale, detached node.
        // (Drag-release-in-gray-zone is handled separately by
        // suppressNextBoxClickRef; the dragged element still resolves here.)
        //
        // One lost member is not the whole selection though. A multi-select that
        // loses its primary here used to be wiped entirely, so moving a group and
        // having any one of its elements fail to re-resolve deselected all of
        // them. Re-resolve the group instead and keep whoever survived; it only
        // clears when nobody did.
        const group = domEditGroupSelectionsRef.current;
        logSelect("preview-sync-lost", {
          target: currentSelection.selector ?? currentSelection.id ?? null,
          group: group.length,
        });
        if (group.length > 1) {
          await refreshDomEditGroupSelectionsFromPreview(group);
          return;
        }
        applyDomSelection(null, { revealPanel: false });
        return;
      }

      const nextSelection = await buildDomSelectionFromTarget(nextElement);
      // Resolving an editable source can outlive a click, a load, or navigation.
      // A background refresh must never take selection ownership back from the
      // user's newer intent or publish geometry from the replaced document.
      if (
        cancelled ||
        generation !== refreshGeneration ||
        domEditSelectionRef.current !== currentSelection ||
        domEditGroupSelectionsRef.current !== currentGroup ||
        !nextElement.isConnected
      ) return;
      try {
        if (previewIframe.contentDocument !== doc) return;
      } catch {
        return;
      }
      if (nextSelection) {
        applyDomSelection(nextSelection, { revealPanel: false, preserveGroup: true });
      }
    };

    syncPreviewHotkeys(previewIframe);
    void applyStudioManualEditsToPreviewRef.current(previewIframe);
    void syncSelectionFromDocument();
    refreshPreviewDocumentVersion();

    const handleLoad = () => {
      syncPreviewHotkeys(previewIframe);
      void applyStudioManualEditsToPreviewRef.current(previewIframe);
      void syncSelectionFromDocument();
      refreshPreviewDocumentVersion();
    };

    previewIframe.addEventListener("load", handleLoad);
    return () => {
      cancelled = true;
      previewIframe.removeEventListener("load", handleLoad);
    };
  }, [
    activeCompPath,
    applyDomSelection,
    buildDomSelectionFromTarget,
    captionEditMode,
    domEditGroupSelectionsRef,
    domEditSelectionRef,
    previewIframe,
    refreshDomEditGroupSelectionsFromPreview,
    refreshPreviewDocumentVersion,
    syncPreviewHotkeys,
    applyStudioManualEditsToPreviewRef,
    gsapCacheVersion,
  ]);
}
