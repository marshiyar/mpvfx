import { useCallback, useEffect, useRef, type RefObject } from "react";
import { LeftSidebar, type LeftSidebarHandle } from "./sidebar/LeftSidebar";
import { usePanelLayoutContext } from "../contexts/PanelLayoutContext";
import { useStudioShellContext } from "../contexts/StudioContext";
import { useFileManagerContext } from "../contexts/FileManagerContext";
import {
  getPersistedRenderSettings,
  persistedRenderDimensions,
  resolvePersistedRenderResolution,
} from "./renders/renderSettings";
import type { BlockPreviewInfo } from "./sidebar/BlocksTab";
import { readAuthoredExportDimensions } from "../utils/exportPolicy";

export interface StudioLeftSidebarProps {
  leftSidebarRef: RefObject<LeftSidebarHandle | null>;
  masterComposition: string | null;
  onSelectComposition: (comp: string) => void;
  onAddBlock: (blockName: string) => void;
  onPreviewBlock?: (preview: BlockPreviewInfo | null) => void;
  onAddAssetToTimeline?: (path: string) => void;
  onAddCompositionToTimeline?: (path: string) => void;
}

// fallow-ignore-next-line complexity
export function StudioLeftSidebar({
  leftSidebarRef,
  masterComposition,
  onSelectComposition,
  onAddBlock,
  onPreviewBlock,
  onAddAssetToTimeline,
  onAddCompositionToTimeline,
}: StudioLeftSidebarProps) {
  const {
    effectiveLeftCollapsed,
    leftWidth,
    adjustPanelWidth,
    toggleLeftSidebar,
    handlePanelResizeStart,
    handlePanelResizeMove,
    handlePanelResizeEnd,
    setRightPanelTab,
    setRightCollapsed,
  } = usePanelLayoutContext();
  const {
    projectId,
    activeCompPath,
    setActiveCompPath,
    renderQueue,
    waitForPendingDomEditSaves,
  } = useStudioShellContext();
  const {
    compositions,
    assets,
    handleDeleteFile,
    handleDeleteComposition,
    handleRenameFile,
    handleImportFiles,
  } = useFileManagerContext();

  const activeCompPathRef = useRef(activeCompPath);
  activeCompPathRef.current = activeCompPath;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleDeleteReusableScene = useCallback(
    async (comp: string) => {
      const deletingProjectId = projectIdRef.current;
      const deleted = await handleDeleteComposition(comp);
      if (
        deleted &&
        mountedRef.current &&
        projectIdRef.current === deletingProjectId &&
        activeCompPathRef.current === comp
      ) {
        setActiveCompPath(null);
      }
    },
    [handleDeleteComposition, setActiveCompPath],
  );

  const handleRenderComposition = useCallback(
    async (comp: string) => {
      // startRender refuses without an encoder, so nothing unfinishable gets
      // queued either way. What it cannot do from here is show the reason:
      // its refusal lands as a row in the Renders panel, which may be
      // collapsed or on another tab, so the click would look like nothing
      // happened. Same move the header makes: put the prompt in front of the
      // user, then stop.
      if (renderQueue.ffmpegMissing) {
        setRightPanelTab("renders");
        setRightCollapsed(false);
        return;
      }
      await waitForPendingDomEditSaves();
      const settings = getPersistedRenderSettings();
      let dimensions = persistedRenderDimensions(settings);
      if (
        !dimensions &&
        (settings.resolution === "1080p" || settings.resolution === "4k") &&
        projectId
      ) {
        try {
          const response = await fetch(
            `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(comp)}`,
          );
          if (!response.ok) throw new Error(`Failed to read scene (${response.status})`);
          const payload = (await response.json()) as { content?: unknown };
          if (typeof payload.content !== "string") throw new Error("Scene content is missing");
          const authoredDimensions = readAuthoredExportDimensions(payload.content);
          const migratedResolution = resolvePersistedRenderResolution(
            settings.resolution,
            authoredDimensions,
          );
          if (migratedResolution === "1080p" || migratedResolution === "4k") {
            throw new Error("Scene canvas dimensions are unavailable");
          }
          dimensions = persistedRenderDimensions(
            { ...settings, resolution: migratedResolution },
            authoredDimensions,
          );
        } catch (error) {
          console.error("[Studio] Could not restore legacy scene export size", error);
          return;
        }
      }
      await renderQueue.startRender({
        composition: comp,
        format: settings.format,
        quality: settings.quality,
        fps: settings.fps,
        ...(dimensions ? { dimensions } : {}),
      });
    },
    [renderQueue, waitForPendingDomEditSaves, setRightPanelTab, setRightCollapsed],
  );

  if (effectiveLeftCollapsed) {
    return (
      <div className="mr-0.5 flex w-10 flex-shrink-0 flex-col items-center rounded-lg border border-neutral-800/50 bg-neutral-950 pt-1">
        <button
          type="button"
          onClick={toggleLeftSidebar}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-neutral-500 transition-colors hover:border-neutral-800 hover:bg-neutral-900 hover:text-neutral-300"
          title="Show sidebar"
          aria-label="Show sidebar"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 4v16" />
            <path d="m10 7 5 5-5 5" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <>
      <LeftSidebar
        ref={leftSidebarRef}
        width={leftWidth}
        projectId={projectId}
        compositions={compositions}
        masterComposition={masterComposition}
        assets={assets}
        activeComposition={activeCompPath}
        onSelectComposition={onSelectComposition}
        onDeleteFile={handleDeleteFile}
        onDeleteComposition={handleDeleteReusableScene}
        onRenameFile={handleRenameFile}
        onImportFiles={async (files, dir) => {
          await handleImportFiles(files, dir);
        }}
        onRenderComposition={handleRenderComposition}
        isRendering={renderQueue.isRendering}
        onToggleCollapse={toggleLeftSidebar}
        onAddBlock={onAddBlock}
        onPreviewBlock={onPreviewBlock}
        onAddAssetToTimeline={onAddAssetToTimeline}
        onAddCompositionToTimeline={onAddCompositionToTimeline}
      />
      {/* Vertical resize divider: 3px visible seam, 13px pointer-capture zone via
          the absolutely-positioned inner hit area. The outer element is w-[3px] so
          it contributes only 3px of gap in the flex row; the inner -left-[2px]
          element widens the hit area without affecting layout. */}
      <div
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        tabIndex={0}
        className="group relative w-[3px] flex-shrink-0 cursor-col-resize outline-none focus-visible:bg-studio-accent/20"
        style={{ touchAction: "none" }}
        onPointerDown={(e) => handlePanelResizeStart("left", e)}
        onPointerMove={handlePanelResizeMove}
        onPointerUp={handlePanelResizeEnd}
        onPointerCancel={handlePanelResizeEnd}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const delta = e.key === "ArrowLeft" ? -16 : 16;
          adjustPanelWidth("left", delta);
        }}
      >
        {/* Expanded hit zone, deliberately asymmetric: 2px into the sidebar card,
            the 3px seam, then 8px into the preview pane's p-2 stage gutter — the
            only dead space adjacent to this seam. It stops at 13px rather than the
            24px WCAG 2.2 (2.5.8) target because the next pixel on either side is
            live: the sidebar's scrolling tab content on the left, the preview
            stage on the right. Silently stealing their clicks is the worse bug. */}
        <div className="absolute inset-y-0 -left-[2px] w-[13px]" />
        {/* Visible hairline */}
        <div className="absolute top-1/2 left-0 h-[52px] w-[3px] -translate-y-1/2 bg-white/12 transition-colors group-hover:bg-white/18 group-active:bg-white/24" />
      </div>
    </>
  );
}
