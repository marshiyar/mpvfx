import { useCallback } from "react";
import type { StudioRightPanelProps } from "./StudioRightPanel.types";

export type { StudioRightPanelProps };
import { PropertyPanel } from "./editor/PropertyPanel";
import { CaptionPropertyPanel } from "../captions/components/CaptionPropertyPanel";
import { BlockParamsPanel } from "./editor/BlockParamsPanel";
import { RenderQueuePanel } from "./renders/RenderQueuePanel";
import { StudioRightPanelTabs } from "./StudioRightSidebarChrome";
import type { RenderJob } from "./renders/useRenderQueue";
import { useStudioPlaybackContext, useStudioShellContext } from "../contexts/StudioContext";
import { usePanelLayoutContext } from "../contexts/PanelLayoutContext";
import { useFileManagerContext } from "../contexts/FileManagerContext";
import { useDomEditContext } from "../contexts/DomEditContext";
import { usePlayerStore } from "../player";
import {
  applyColorGradingScopeUpdate,
  EMPTY_COLOR_GRADING_SCOPE_RESULT,
  type ColorGradingScope,
} from "./studioColorGradingScope";
import { timelineKeysForSelections } from "../utils/studioHelpers";
import { canHideSelections } from "../utils/timelineInspector";
import { useRemoveBackground } from "../hooks/useRemoveBackground";

// fallow-ignore-next-line complexity
export function StudioRightPanel({
  designPanelActive,
  activeBlockParams,
  onCloseBlockParams,
  recordingState,
  recordingDuration,
  onToggleRecording,
  reloadPreview,
  domEditSaveTimestampRef,
  recordEdit,
  onToggleElementHidden,
  onAutoGroupCarveSources,
  onAddMediaOverlay,
}: StudioRightPanelProps) {
  const {
    rightWidth,
    adjustPanelWidth,
    setRightCollapsed,
    rightPanelTab,
    setRightPanelTab,
    handlePanelResizeStart,
    handlePanelResizeMove,
    handlePanelResizeEnd,
  } = usePanelLayoutContext();

  const {
    previewIframeRef,
    projectId,
    activeCompPath,
    showToast,
    waitForPendingDomEditSaves,
    renderQueue,
  } = useStudioShellContext();
  const { captionEditMode } = useStudioPlaybackContext();

  const {
    domEditSelection,
    domEditGroupSelections,
    clearDomSelection,
    handleUngroupSelection,
    handleGroupSelection,
    handleDomStyleCommit,
    handleDomStylePreview,
    handleDomDesignReset,
    handleDomAttributeCommit,
    handleDomAttributeLiveCommit,
    handleDomAttributeQuietCommit,
    handleDomHtmlAttributeCommit,
    handleDomAttributesCommit,
    handleDomPathOffsetCommit,
    handleDomBoxSizeCommit,
    handleDomRotationCommit,
    handleDomTextCommit,
    handleDomTextFieldStyleCommit,
    handleDomAddTextField,
    handleDomRemoveTextField,
    selectedGsapAnimations,
    gsapMultipleTimelines,
    gsapUnsupportedTimelinePattern,
    handleGsapUpdateProperty,
    handleGsapUpdateMeta,
    handleGsapDeleteAnimation,
    handleGsapAddAnimation,
    handleGsapAddProperty,
    handleGsapRemoveProperty,
    handleGsapUpdateFromProperty,
    handleGsapAddFromProperty,
    handleGsapRemoveFromProperty,
    commitAnimatedProperty,
    commitAnimatedProperties,
    commitKeyframeProperty,
    commitKeyframeProperties,
    isNativeSelection,
    nativeProjectDocument,
    deleteNativeKeyframe,
    setNativeKeyframesInterpolation,
    handleSetArcPath,
    handleUpdateArcSegment,
    handleUnroll,
    handleUpdateKeyframeEase,
    handleUpdateSegmentEase,
    handleSetAllKeyframeEases,
    handleGsapAddKeyframe,
    handleGsapRemoveKeyframe,
    handleGsapConvertToKeyframes,
  } = useDomEditContext();

  const {
    assets,
    fontAssets,
    projectDir,
    handleImportFiles,
    handleImportFonts,
    refreshFileTree,
    readProjectFile,
    writeProjectFile,
    fileTree,
  } = useFileManagerContext();

  const renderJobs = renderQueue.jobs as RenderJob[];
  const inspectorTabActive = rightPanelTab === "design";
  const designPaneOpen = inspectorTabActive && designPanelActive;

  const handleApplyColorGradingScope = useCallback(
    async (scope: ColorGradingScope, value: string | null) =>
      applyColorGradingScopeUpdate({
        scope,
        value,
        selectedSourceFile: domEditSelection?.sourceFile || activeCompPath || "index.html",
        fileTree,
        projectId,
        domEditSaveTimestampRef,
        waitForPendingDomEditSaves,
        readProjectFile,
        writeProjectFile,
        recordEdit,
        reloadPreview,
        showToast,
      }).catch((error) => {
        showToast(
          `Couldn't apply color grading: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return EMPTY_COLOR_GRADING_SCOPE_RESULT;
      }),
    [
      activeCompPath,
      domEditSaveTimestampRef,
      domEditSelection?.sourceFile,
      fileTree,
      projectId,
      readProjectFile,
      recordEdit,
      reloadPreview,
      showToast,
      waitForPendingDomEditSaves,
      writeProjectFile,
    ],
  );

  const handleRemoveBackground = useRemoveBackground(projectId, refreshFileTree, showToast);

  /**
   * A dial being dragged writes to the preview and stops there.
   *
   * Every one of these panels previews on each pointermove and commits on
   * release. Persisting the moves too put a fragment of the drag in the undo
   * stack — and since those writes race, history could not coalesce them
   * reliably, so undo took back a sliver of the gesture rather than the gesture.
   * The release's own commit is what reaches the file and the undo stack.
   */
  const previewAttributeWhileDragging = useCallback(
    (attr: string, value: string | null, onSettled?: (ok: boolean) => void) =>
      handleDomAttributeLiveCommit(attr, value, onSettled, { previewOnly: true }),
    [handleDomAttributeLiveCommit],
  );
  const handleHideAllSelected = () => {
    // Audio has no visual to hide, and `data-hidden` on an audio element is what
    // MUTES it — preview silences it and the render drops it from the mix. The
    // timeline withholds the eye on an audio track for that reason
    // (`visible={!isAudioTrack}`), and the single-selection panel gates the same
    // write on `audioSelection`; this multi-selection path was the way back to
    // it. Checked here as well as in the panel because the button is not the
    // only caller.
    if (!canHideSelections(domEditGroupSelections)) {
      showToast("Audio can't be hidden — use the group's own controls", "info");
      return;
    }
    const { elements } = usePlayerStore.getState();
    const keys = timelineKeysForSelections(domEditGroupSelections, elements, activeCompPath);
    if (keys.length > 0) void onToggleElementHidden?.(keys, true);
  };
  const propertyPanel = (
    <PropertyPanel
        projectId={projectId}
        projectDir={projectDir}
        assets={assets}
        element={domEditGroupSelections.length > 1 ? null : domEditSelection}
        multiSelectCount={domEditGroupSelections.length}
        multiSelectedElements={domEditGroupSelections}
        onGroupSelection={handleGroupSelection}
        onHideAllSelected={handleHideAllSelected}
        onClearSelection={clearDomSelection}
        onToggleElementHidden={onToggleElementHidden}
        onAutoGroupCarveSources={onAutoGroupCarveSources}
        onUngroup={handleUngroupSelection}
        onSetStyle={handleDomStyleCommit}
        onPreviewStyle={handleDomStylePreview}
        onResetDesign={handleDomDesignReset}
        onSetAttribute={handleDomAttributeCommit}
        onSetAttributes={handleDomAttributesCommit}
        onSetAttributeLive={handleDomAttributeLiveCommit}
        onPreviewAttributeLive={previewAttributeWhileDragging}
        onSetAttributeQuiet={handleDomAttributeQuietCommit}
        onApplyColorGradingScope={handleApplyColorGradingScope}
        onSetHtmlAttribute={handleDomHtmlAttributeCommit}
        onRemoveBackground={handleRemoveBackground}
        onSetManualOffset={handleDomPathOffsetCommit}
        onSetManualSize={handleDomBoxSizeCommit}
        onSetManualRotation={handleDomRotationCommit}
        onSetText={handleDomTextCommit}
        onSetTextFieldStyle={handleDomTextFieldStyleCommit}
        onAddTextField={handleDomAddTextField}
        onRemoveTextField={handleDomRemoveTextField}
        onImportAssets={handleImportFiles}
        onAddMediaOverlay={onAddMediaOverlay}
        fontAssets={fontAssets}
        onImportFonts={handleImportFonts}
        previewIframeRef={previewIframeRef}
        gsapAnimations={selectedGsapAnimations}
        nativeKeyframeTarget={
          domEditSelection ? isNativeSelection(domEditSelection) : false
        }
        nativeProjectDocument={nativeProjectDocument}
        onRemoveNativeKeyframe={deleteNativeKeyframe}
        onSetNativeKeyframesInterpolation={setNativeKeyframesInterpolation}
        gsapMultipleTimelines={gsapMultipleTimelines}
        gsapUnsupportedTimelinePattern={gsapUnsupportedTimelinePattern}
        onUpdateGsapProperty={handleGsapUpdateProperty}
        onUpdateGsapMeta={handleGsapUpdateMeta}
        onDeleteGsapAnimation={handleGsapDeleteAnimation}
        onAddGsapProperty={handleGsapAddProperty}
        onRemoveGsapProperty={handleGsapRemoveProperty}
        onUpdateGsapFromProperty={handleGsapUpdateFromProperty}
        onAddGsapFromProperty={handleGsapAddFromProperty}
        onRemoveGsapFromProperty={handleGsapRemoveFromProperty}
        onAddGsapAnimation={handleGsapAddAnimation}
        onCommitAnimatedProperty={commitAnimatedProperty}
        onCommitAnimatedProperties={commitAnimatedProperties}
        onCommitKeyframeProperty={commitKeyframeProperty}
        onCommitKeyframeProperties={commitKeyframeProperties}
        onAddKeyframe={handleGsapAddKeyframe}
        onRemoveKeyframe={handleGsapRemoveKeyframe}
        onConvertToKeyframes={(animId, duration) =>
          handleGsapConvertToKeyframes(animId, undefined, duration)
        }
        onSeekToTime={(t) => usePlayerStore.getState().requestSeek(t)}
        onSetArcPath={handleSetArcPath}
        onUpdateArcSegment={handleUpdateArcSegment}
        onUnroll={handleUnroll}
        onUpdateKeyframeEase={handleUpdateKeyframeEase}
        onUpdateSegmentEase={handleUpdateSegmentEase}
        onSetAllKeyframeEases={handleSetAllKeyframeEases}
        recordingState={recordingState}
        recordingDuration={recordingDuration}
        onToggleRecording={onToggleRecording}
    />
  );

  const renderQueuePanel = <RenderQueuePanel />;

  return (
    <>
      {/* Vertical resize divider: 3px visible seam, 13px hit zone via the inner div. */}
      <div
        role="separator"
        aria-label="Resize inspector panel"
        aria-orientation="vertical"
        tabIndex={0}
        className="group relative w-[3px] flex-shrink-0 cursor-col-resize outline-none focus-visible:bg-studio-accent/20"
        style={{ touchAction: "none" }}
        onPointerDown={(e) => handlePanelResizeStart("right", e)}
        onPointerMove={handlePanelResizeMove}
        onPointerUp={handlePanelResizeEnd}
        onPointerCancel={handlePanelResizeEnd}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          // Panel is right-anchored: ArrowLeft grows it, ArrowRight shrinks it.
          const delta = e.key === "ArrowLeft" ? 16 : -16;
          adjustPanelWidth("right", delta);
        }}
      >
        {/* Asymmetric hit zone: 8px into the preview's p-2 gutter (the only dead
            space), the 3px seam, 2px into the card. Stops short of the 24px WCAG
            2.5.8 target because the next pixel each way is live. */}
        <div className="absolute inset-y-0 -left-[8px] w-[13px]" />
        {/* Visible hairline */}
        <div className="absolute top-1/2 left-0 h-[52px] w-[3px] -translate-y-1/2 bg-white/12 transition-colors group-hover:bg-white/18 group-active:bg-white/24" />
      </div>
      <div
        className="flex min-w-0 flex-shrink-0 flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950"
        style={{ width: rightWidth }}
      >
        {captionEditMode ? (
          <CaptionPropertyPanel iframeRef={previewIframeRef} />
        ) : (
          <>
            <StudioRightPanelTabs
              designActive={designPaneOpen}
              rendersActive={rightPanelTab === "renders"}
              rendersLabel={renderJobs.length > 0 ? `Renders (${renderJobs.length})` : "Renders"}
              onHide={() => setRightCollapsed(true)}
              onDesign={() => setRightPanelTab("design")}
              onRenders={() => setRightPanelTab("renders")}
            />
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
              {rightPanelTab === "block-params" && activeBlockParams ? (
                <BlockParamsPanel
                  blockName={activeBlockParams.blockName}
                  blockTitle={activeBlockParams.blockTitle}
                  params={activeBlockParams.params}
                  compositionPath={activeBlockParams.compositionPath}
                  onClose={onCloseBlockParams ?? (() => {})}
                />
              ) : designPaneOpen ? (
                propertyPanel
              ) : inspectorTabActive ? (
                // Inspector tab selected but no pane can render (panes toggled
                // off, or inspector inactive during playback/recording): show an
                // explanation instead of silently rendering the render queue
                // under a highlighted inspector tab.
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-xs text-neutral-500">
                    Inspector is unavailable right now — select Design above, or pause
                    playback/recording to inspect elements.
                  </p>
                  <button
                    type="button"
                    onClick={() => setRightPanelTab("renders")}
                    className="h-7 rounded-md border border-neutral-800 px-3 text-[11px] font-medium text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200 active:scale-[0.98]"
                  >
                    Show Renders
                  </button>
                </div>
              ) : (
                renderQueuePanel
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
