import { useEffect, useRef, type MutableRefObject } from "react";
import type { DomEditSelection } from "../canvas/domEditing";

interface PreviewSelectionRefreshOptions {
  projectId: string | null;
  domEditSelectionRef: MutableRefObject<DomEditSelection | null>;
  refreshKey: number;
  previewDocumentVersion: number;
  refreshDomEditSelectionFromPreview: (selection: DomEditSelection) => Promise<void>;
}

/** Re-resolve the local selection once the replacement preview document loads. */
export function usePreviewSelectionRefresh({
  projectId,
  domEditSelectionRef,
  refreshKey,
  previewDocumentVersion,
  refreshDomEditSelectionFromPreview,
}: PreviewSelectionRefreshOptions): void {
  const previous = useRef({ projectId, refreshKey, previewDocumentVersion });
  const pendingRefresh = useRef(false);

  useEffect(() => {
    const last = previous.current;
    previous.current = { projectId, refreshKey, previewDocumentVersion };
    if (last.projectId !== projectId) {
      pendingRefresh.current = false;
      return;
    }
    if (last.refreshKey !== refreshKey) {
      pendingRefresh.current = Boolean(projectId && domEditSelectionRef.current);
    }
    if (!pendingRefresh.current || last.previewDocumentVersion === previewDocumentVersion) return;
    // Later 80/300ms settling ticks must not repeat the refresh, and a cleared
    // selection must not be resurrected after navigation.
    pendingRefresh.current = false;
    const selection = domEditSelectionRef.current;
    if (selection) void refreshDomEditSelectionFromPreview(selection);
  }, [domEditSelectionRef, projectId, refreshKey, previewDocumentVersion, refreshDomEditSelectionFromPreview]);
}
