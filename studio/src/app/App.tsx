import { useState, useCallback, useRef, useMemo, useLayoutEffect, useEffect } from "react";
import type { LeftSidebarHandle } from "../features/media/LeftSidebar";
import { useRenderQueue } from "../features/export/useRenderQueue";
import { usePlayerStore } from "../player/index";
import { StudioOverlays } from "./StudioOverlays";
import { SaveQueuePausedBanner } from "./SaveQueuePausedBanner";
import { ExternalFileConflictBanner } from "./ExternalFileConflictBanner";
import { useCaptionStore } from "../captions/store";
import { useCaptionSync } from "../captions/hooks/useCaptionSync";
import { usePersistentEditHistory } from "../features/history/usePersistentEditHistory";
import { usePanelLayout } from "./usePanelLayout";
import { useFileManager } from "../features/history/useFileManager";
import { usePreviewPersistence } from "../features/preview/usePreviewPersistence";
import { usePreviewDocumentVersion } from "../features/preview/usePreviewDocumentVersion";
import { useTimelineEditing } from "../features/timeline/useTimelineEditing";
import {
  persistTimelineMoveEditsAtomically,
  type TimelineMoveEditsHandler,
  type TimelineMoveOperation,
} from "../features/timeline/timelineMoveAdapter";
import type { TimelineZIndexReorderCommit } from "../features/timeline/useTimelineEditingTypes";
import type { BlockPreviewInfo } from "../features/media/BlocksTab";
import { useDomEditSession } from "../features/canvas/useDomEditSession";
import { useSdkSelectionSync } from "../features/legacy/useSdkSelectionSync";
import { useStudioSdkSessions } from "../features/legacy/useStudioSdkSessions";
import { useStudioExternalFileChanges } from "../features/history/useStudioExternalFileChanges";
import { useBlockHandlers } from "../features/media/useBlockHandlers";
import { useAppHotkeys } from "./useAppHotkeys";
import { useClipboard } from "../features/canvas/useClipboard";
import { deleteSelectedKeyframes } from "../features/timeline/timelineEditingHelpers";
import { clearKeyframeInteractionAfterHistory } from "../features/animation/Keyframe/keyframeHistoryState";
import { useCaptionDetection } from "../captions/hooks/useCaptionDetection";
import { useRenderClipContent } from "../features/preview/useRenderClipContent";
import { useCompositionDimensions } from "../features/preview/useCompositionDimensions";
import { useToast } from "./useToast";
import { useCompositionContentLoader } from "../features/preview/useCompositionContentLoader";
import { useStudioUrlState } from "./useStudioUrlState";
import { useEffectiveTimelineDuration } from "../features/timeline/useEffectiveTimelineDuration";
import {
  buildStudioContextValue,
  useGlobalFileDrop,
  useInspectorState,
} from "./useStudioContextValue";
import type { DomEditSelection } from "../features/canvas/domEditing";
import { useGestureCommit } from "../features/canvas/useGestureCommit";
import { GestureTrailOverlay } from "../features/canvas/GestureTrailOverlay";
import { StudioLeftSidebar } from "./StudioLeftSidebar";
import { EditorShell } from "./EditorShell";
import { StudioRightPanel } from "./StudioRightPanel";
import { StudioRightSidebarRail } from "./StudioRightSidebarChrome";
import { TimelineToolbar } from "../features/timeline/TimelineToolbar";
import { StudioPlaybackProvider, StudioShellProvider } from "./StudioContext";
import { PanelLayoutProvider } from "./PanelLayoutContext";
import { FileManagerProvider } from "../features/history/FileManagerContext";
import { DomEditProvider } from "../features/canvas/DomEditContext";
import { StudioSplash } from "./StudioSplash";
import { useDesktopProject } from "./useDesktopProject";
import { useStudioSessionStart } from "./useStudioSessionStart";
import { useTimelineAddAtPlayhead } from "../features/timeline/useTimelineAddAtPlayhead";
import { readStudioUrlStateFromWindow, resolveMasterCompositionPath } from "./studioUrlState";
import { useHydrateActiveCompPathFromUrl } from "./useHydrateActiveCompPathFromUrl";
import { useNativeProjectSession } from "../features/project/useNativeProjectSession";
import { useNativeProjectBootstrap } from "../features/project/useNativeProjectBootstrap";
import type { NativeProjectHistoryEntry } from "../features/project/nativeProjectPersistence";
import { fetchParsedAnimations } from "../features/animation/Keyframe/keyframeCacheAstLoad";
import { useDurableStudioFileTransactions } from "../features/history/useDurableStudioFileTransactions";
const getTimelineSelectionSet = () => usePlayerStore.getState().selectedElementIds;
// fallow-ignore-next-line complexity
export function StudioApp() {
  const { projectId, resolving, waitingForRuntime } = useDesktopProject();
  const initialUrlStateRef = useRef(readStudioUrlStateFromWindow());
  useStudioSessionStart(projectId, resolving, waitingForRuntime);
  const [activeCompPath, setActiveCompPath] = useState<string | null>(null);
  const [activeCompPathHydrated, setActiveCompPathHydrated] = useState(
    () => initialUrlStateRef.current.activeCompPath == null,
  );
  const [compIdToSrc, setCompIdToSrc] = useState<Map<string, string>>(new Map());
  const [previewIframe, setPreviewIframe] = useState<HTMLIFrameElement | null>(null);
  const [compositionLoading, setCompositionLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [nativeProjectReloadToken, setNativeProjectReloadToken] = useState(0);
  const [previewDocumentVersion, refreshPreviewDocumentVersion] = usePreviewDocumentVersion();
  const [blockPreview, setBlockPreview] = useState<BlockPreviewInfo | null>(null);
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const activeCompPathRef = useRef(activeCompPath);
  activeCompPathRef.current = activeCompPath;
  const leftSidebarRef = useRef<LeftSidebarHandle>(null);
  const renderQueue = useRenderQueue(projectId, activeCompPathRef);
  const captionEditMode = useCaptionStore((s) => s.isEditMode);
  const captionHasSelection = useCaptionStore((s) => s.selectedSegmentIds.size > 0);
  const captionSync = useCaptionSync(projectId);
  const timelineElements = usePlayerStore((s) => s.elements);
  const setSelectedTimelineElementId = usePlayerStore((s) => s.setSelectedElementId);
  const setTimelineSelectionSet = usePlayerStore((s) => s.setSelectedElementIds);
  const timelineDuration = usePlayerStore((s) => s.duration);
  const timelineFrameRate = usePlayerStore((s) => s.timelineFrameRate);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const effectiveTimelineDuration = useEffectiveTimelineDuration(
    timelineDuration,
    timelineElements,
  );
  const { toasts, showToast, dismissToast } = useToast();
  const panelLayout = usePanelLayout({
    rightCollapsed: initialUrlStateRef.current.rightCollapsed,
    rightPanelTab: initialUrlStateRef.current.rightPanelTab,
  });
  const editHistory = usePersistentEditHistory({ projectId });
  const commitNativeFileTransaction = useDurableStudioFileTransactions({
    projectId,
    historyLoaded: editHistory.loaded,
    recordDurableEdit: editHistory.recordDurableEdit,
    showToast,
  });
  const domEditSaveTimestampRef = useRef(0);
  const handleDomZIndexReorderCommitRef = useRef<TimelineZIndexReorderCommit | null>(null);
  const pendingTimelineEditPathRef = useRef(new Set<string>());
  const isGestureRecordingRef = useRef(false);
  const reloadPreview = useCallback(() => setRefreshKey((k) => k + 1), []);
  const fileManager = useFileManager({
    projectId,
    recordDurableEdit: editHistory.recordDurableEdit,
    showToast,
    setRefreshKey,
  });
  const compositionDimensions = useCompositionDimensions(
    `${projectId}:${activeCompPath ?? ""}`,
    previewIframeRef,
  );
  const handleNativeDuration = useCallback((durationSeconds: number) => {
    usePlayerStore.getState().setDuration(durationSeconds);
  }, []);
  const getNativePlaybackRate = useCallback(
    () => usePlayerStore.getState().playbackRate,
    [],
  );
  const getNativePlayheadSeconds = useCallback(
    () => usePlayerStore.getState().currentTime,
    [],
  );
  const nativeProjectSession = useNativeProjectSession({
    projectId,
    readOptionalProjectFile: fileManager.readOptionalProjectFile,
    iframe: previewIframe,
    reloadToken: `${refreshKey}:${nativeProjectReloadToken}`,
    onNativeDuration: handleNativeDuration,
    getPlaybackRate: getNativePlaybackRate,
    getPlayheadSeconds: getNativePlayheadSeconds,
  });
  const readLegacyAnimations = useCallback(
    async (legacyProjectId: string, sourceFile: string) =>
      (await fetchParsedAnimations(legacyProjectId, sourceFile))?.animations ?? null,
    [],
  );
  const nativeBootstrapState = useNativeProjectBootstrap({
    status: nativeProjectSession.status,
    projectId,
    compositionDimensions,
    frameRate: timelineFrameRate,
    timelineElements,
    readLegacyAnimations,
  });
  const nativeBootstrapDocument = nativeBootstrapState.document;
  useEffect(() => {
    if (nativeProjectSession.status !== "error" || !nativeProjectSession.error) return;
    showToast(`Native project could not be loaded: ${nativeProjectSession.error.message}`, "error");
  }, [nativeProjectSession.error, nativeProjectSession.status, showToast]);
  const recordNativeProjectHistory = useCallback(
    async (entry: NativeProjectHistoryEntry) => {
      await editHistory.recordEdit({
        label: entry.label,
        kind: "motion",
        files: {
          [entry.path]: { before: entry.before ?? "", after: entry.after },
        },
      });
    },
    [editHistory.recordEdit],
  );
  const handleNativeDocumentCommitted = useCallback(() => {
    setNativeProjectReloadToken((token) => token + 1);
  }, []);
  const nativeProjectEditing = useMemo(
    () => ({
      nativeDocument: nativeProjectSession.document,
      nativeBootstrapDocument,
      readOptionalProjectFile: fileManager.readOptionalProjectFile,
      writeProjectFile: fileManager.writeProjectFile,
      recordHistory: recordNativeProjectHistory,
      onNativeDocumentCommitted: handleNativeDocumentCommitted,
      commitFileTransaction: commitNativeFileTransaction,
      getPlayheadSeconds: getNativePlayheadSeconds,
    }),
    [
      fileManager.readOptionalProjectFile,
      fileManager.writeProjectFile,
      commitNativeFileTransaction,
      getNativePlayheadSeconds,
      handleNativeDocumentCommitted,
      nativeProjectSession.document,
      nativeBootstrapDocument,
      recordNativeProjectHistory,
    ],
  );
  const masterCompPath = useMemo(
    () => resolveMasterCompositionPath(fileManager.compositions, projectId),
    [fileManager.compositions, projectId],
  );
  const { sdkHandle, editFlowSdkSession } = useStudioSdkSessions(projectId, activeCompPath);
  useHydrateActiveCompPathFromUrl({
    hydrated: activeCompPathHydrated,
    fileTreeLoaded: fileManager.fileTreeLoaded,
    fileTree: fileManager.fileTree,
    initialUrlStateRef,
    setActiveCompPath,
    setHydrated: setActiveCompPathHydrated,
  });
  const previewPersistence = usePreviewPersistence({
    showToast,
    readOptionalProjectFile: fileManager.readOptionalProjectFile,
    writeProjectFile: fileManager.writeProjectFile,
    recordEdit: editHistory.recordEdit,
    previewIframeRef,
    activeCompPathRef,
    reloadPreview: () => setRefreshKey((k) => k + 1),
  });
  const externalFileChanges = useStudioExternalFileChanges({
    projectId,
    activeCompPath,
    masterCompPath,
    fileManager,
    previewPersistence,
    pendingTimelineEditPathRef,
    reloadPreview,
  });
  const invalidateGsapCacheRef = useRef<() => void>(() => {});
  const invalidateGsapCache = useCallback(() => invalidateGsapCacheRef.current(), []);
  const timelineEditing = useTimelineEditing({
    projectId,
    activeCompPath,
    timelineElements,
    showToast,
    writeProjectFile: fileManager.writeProjectFile,
    observeProjectFileVersion: fileManager.observeProjectFileVersion,
    recordEdit: editHistory.recordEdit,
    domEditSaveTimestampRef,
    reloadPreview,
    previewIframeRef,
    pendingTimelineEditPathRef,
    uploadProjectFiles: fileManager.uploadProjectFiles,
    isRecordingRef: isGestureRecordingRef,
    sdkSession: editFlowSdkSession,
    publishSdkSession: sdkHandle.publish,
    forceReloadSdkSession: sdkHandle.forceReload,
    invalidateGsapCache,
    handleDomZIndexReorderCommitRef,
    nativeProjectEditing,
  });
  const handleTimelineElementsMove: TimelineMoveEditsHandler = useCallback(
    async (edits, coalesceKey, operation: TimelineMoveOperation = "timing", coalesceMs) => {
      const deps = { handleTimelineGroupMove: timelineEditing.handleTimelineGroupMove };
      await persistTimelineMoveEditsAtomically(edits, coalesceKey, operation, deps, coalesceMs);
    },
    [timelineEditing.handleTimelineGroupMove],
  );
  const {
    addAssetAtPlayhead: handleAddAssetAtPlayhead,
    addCompositionAtPlayhead: handleAddCompositionAtPlayhead,
  } = useTimelineAddAtPlayhead(
    timelineEditing.handleTimelineAssetDrop,
    timelineEditing.handleTimelineCompositionDrop,
  );
  const {
    activeBlockParams,
    setActiveBlockParams,
    handleAddBlock,
    handleTimelineBlockDrop,
    handleAddMediaOverlay,
    handlePreviewBlockDrop,
  } = useBlockHandlers({
    projectId,
    blockCtxDeps: {
      activeCompPath,
      timelineElements,
      readProjectFile: fileManager.readProjectFile,
      writeProjectFile: fileManager.writeProjectFile,
      recordEdit: editHistory.recordEdit,
      refreshFileTree: fileManager.refreshFileTree,
      reloadPreview,
      showToast,
    },
    previewIframeRef,
    setRightCollapsed: panelLayout.setRightCollapsed,
    setRightPanelTab: panelLayout.setRightPanelTab,
  });
  const clearDomSelectionRef = useRef<() => void>(() => {});
  const domEditSelectionBridgeRef = useRef<DomEditSelection | null>(null);
  type DomEditDelete = (s: DomEditSelection, o?: { expandGroup?: boolean }) => Promise<void>;
  const handleDomEditElementDeleteRef = useRef<DomEditDelete>(async () => {});
  const domEditDeleteBridge: DomEditDelete = (s, o) => handleDomEditElementDeleteRef.current(s, o);
  const resetKeyframesRef = useRef<() => Promise<boolean>>(async () => false);
  const deleteSelectedKeyframesRef = useRef<() => Promise<boolean>>(async () => false);
  const { handleCopy, handlePaste, handleCut } = useClipboard({
    projectId,
    activeCompPath,
    domEditSelectionRef: domEditSelectionBridgeRef,
    showToast,
    writeProjectFile: fileManager.writeProjectFile,
    recordEdit: editHistory.recordEdit,
    domEditSaveTimestampRef,
    reloadPreview,
    handleTimelineElementDelete: timelineEditing.handleTimelineElementDelete,
    handleDomEditElementDelete: domEditDeleteBridge,
    previewIframeRef,
  });
  const appHotkeys = useAppHotkeys({
    projectId,
    observeProjectFileVersion: fileManager.observeProjectFileVersion,
    handleTimelineElementsDelete: timelineEditing.handleTimelineElementsDelete,
    handleTimelineElementSplit: timelineEditing.handleTimelineElementSplit,
    handleDomEditElementDelete: domEditDeleteBridge,
    domEditSelectionRef: domEditSelectionBridgeRef,
    clearDomSelectionRef,
    editHistory,
    readOptionalProjectFile: fileManager.readOptionalProjectFile,
    readProjectFile: fileManager.readProjectFile,
    writeProjectFile: fileManager.writeProjectFile,
    domEditSaveTimestampRef,
    showToast,
    syncHistoryPreviewAfterApply: previewPersistence.syncHistoryPreviewAfterApply,
    waitForPendingDomEditSaves: previewPersistence.waitForPendingDomEditSaves,
    leftSidebarRef,
    handleCopy,
    handlePaste,
    handleCut,
    onResetKeyframes: () => resetKeyframesRef.current(),
    onDeleteSelectedKeyframes: () => deleteSelectedKeyframesRef.current(),
    onAfterUndoRedo: () => {
      clearKeyframeInteractionAfterHistory();
      invalidateGsapCacheRef.current();
      setNativeProjectReloadToken((token) => token + 1);
      void fileManager.refreshFileTree();
    },
    onGroupSelection: () => domEditSessionRef.current.handleGroupSelection(),
    onUngroupSelection: () => domEditSessionRef.current.handleUngroupSelection(),
    activeCompPath,
    forceReloadSdkSession: sdkHandle.forceReload,
    onToggleRecording: () => handleToggleRecordingRef.current(),
  });
  const domEditSession = useDomEditSession({
    projectId,
    activeCompPath,
    compIdToSrc,
    captionEditMode,
    compositionLoading,
    previewIframeRef,
    timelineElements,
    getTimelineSelectionSet,
    setSelectedTimelineElementId,
    setTimelineSelectionSet,
    setRightCollapsed: panelLayout.setRightCollapsed,
    setRightPanelTab: panelLayout.setRightPanelTab,
    showToast,
    isRecordingRef: isGestureRecordingRef,
    refreshPreviewDocumentVersion,
    queueDomEditSave: previewPersistence.queueDomEditSave,
    readProjectFile: fileManager.readProjectFile,
    writeProjectFile: fileManager.writeProjectFile,
    updateEditingFileContent: fileManager.updateEditingFileContent,
    domEditSaveTimestampRef,
    editHistory: { recordEdit: editHistory.recordEdit },
    fileTree: fileManager.fileTree,
    importedFontAssetsRef: fileManager.importedFontAssetsRef,
    projectDir: fileManager.projectDir,
    projectIdRef: fileManager.projectIdRef,
    previewIframe,
    refreshKey,
    previewDocumentVersion,
    applyStudioManualEditsToPreviewRef: previewPersistence.applyStudioManualEditsToPreviewRef,
    syncPreviewHotkeys: appHotkeys.syncPreviewHotkeys,
    reloadPreview,
    setRefreshKey,
    sdkSession: editFlowSdkSession,
    publishSdkSession: sdkHandle.publish,
    forceReloadSdkSession: sdkHandle.forceReload,
    nativeProjectEditing,
  });
  domEditSelectionBridgeRef.current = domEditSession.domEditSelection;
  handleDomZIndexReorderCommitRef.current = domEditSession.handleDomZIndexReorderCommit;
  clearDomSelectionRef.current = domEditSession.clearDomSelection;
  handleDomEditElementDeleteRef.current = domEditSession.handleDomEditElementDelete;
  resetKeyframesRef.current = domEditSession.handleResetSelectedElementKeyframes;
  invalidateGsapCacheRef.current = domEditSession.invalidateGsapCache;
  deleteSelectedKeyframesRef.current = () => deleteSelectedKeyframes(domEditSession);
  useSdkSelectionSync(
    editFlowSdkSession,
    domEditSession.domEditSelection,
    domEditSession.domEditGroupSelections,
  );
  useCaptionDetection({
    projectId,
    activeCompPath,
    compIdToSrc,
    captionEditMode,
    captionHasSelection,
    previewIframeRef,
    captionSync,
    setRightCollapsed: panelLayout.setRightCollapsed,
  });
  const renderClipContent = useRenderClipContent({
    projectIdRef: fileManager.projectIdRef,
    compIdToSrc,
    activePreviewUrl: activeCompPath
      ? `/api/projects/${projectId}/preview/comp/${activeCompPath}`
      : null,
    effectiveTimelineDuration,
  });
  const fileDrop = useGlobalFileDrop(timelineEditing.handleTimelineFileDrop);
  const handleToggleRecordingRef = useRef<() => void>(() => {});
  const domEditSessionRef = useRef(domEditSession);
  domEditSessionRef.current = domEditSession;
  const { gestureState, gestureRecording, handleToggleRecording } = useGestureCommit({
    domEditSessionRef,
    previewIframeRef,
    showToast,
    isGestureRecordingRef,
  });
  handleToggleRecordingRef.current = handleToggleRecording;
  const canvasRectRef = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (gestureState !== "recording" || !previewIframe) {
      canvasRectRef.current = null;
      return;
    }
    canvasRectRef.current = previewIframe.getBoundingClientRect();
  }, [gestureState, previewIframe]);
  const handlePreviewIframeRef = useCallback(
    (iframe: HTMLIFrameElement | null) => {
      previewIframeRef.current = iframe;
      setPreviewIframe(iframe);
      appHotkeys.syncPreviewHotkeys(iframe);
      refreshPreviewDocumentVersion();
    },
    [appHotkeys, refreshPreviewDocumentVersion],
  );
  const { setEditingFile } = fileManager;
  const handleSelectComposition = useCompositionContentLoader({
    projectId,
    setEditingFile,
    setActiveCompPath,
    showToast,
  });
  const {
    designPanelActive,
    shouldShowMotionPath,
    shouldShowSelectedDomBounds,
  } = useInspectorState(
    panelLayout.rightPanelTab,
    isPlaying,
    domEditSession.domEditSelection,
    gestureState === "recording",
  );
  useStudioUrlState({
    projectId,
    activeCompPath,
    duration: effectiveTimelineDuration,
    isPlaying,
    compositionLoading,
    refreshKey,
    previewIframeRef,
    rightPanelTab: panelLayout.rightPanelTab,
    rightCollapsed: panelLayout.rightCollapsed,
    activeCompPathHydrated,
    domEditSelection: domEditSession.domEditSelection,
    domEditGroupSelections: domEditSession.domEditGroupSelections,
    applyMarqueeSelection: domEditSession.applyMarqueeSelection,
    buildDomSelectionFromTarget: domEditSession.buildDomSelectionFromTarget,
    applyDomSelection: domEditSession.applyDomSelection,
    setRightPanelTab: panelLayout.setRightPanelTab,
    initialState: initialUrlStateRef.current,
  });
  const studioCtxValue = buildStudioContextValue({
    projectId: projectId!,
    activeCompPath,
    setActiveCompPath,
    showToast,
    previewIframeRef,
    captionEditMode,
    compositionLoading,
    refreshKey,
    setRefreshKey,
    timelineElements,
    isPlaying,
    editHistory,
    handleUndo: appHotkeys.handleUndo,
    handleRedo: appHotkeys.handleRedo,
    renderQueue,
    compositionDimensions,
    domEditSaveQueuePaused: previewPersistence.domEditSaveQueuePaused,
    externalFileConflict: externalFileChanges.blocked !== null,
    waitForPendingDomEditSaves: previewPersistence.waitForPendingDomEditSaves,
    handlePreviewIframeRef,
    refreshPreviewDocumentVersion,
  });
  const timelineToolbar = useMemo(
    () => (
      <TimelineToolbar
        domEditSession={domEditSession}
        onSplitElement={timelineEditing.handleTimelineElementSplit}
      />
    ),
    [domEditSession, timelineEditing.handleTimelineElementSplit],
  );
  if (resolving || waitingForRuntime || !projectId)
    return <StudioSplash waiting={waitingForRuntime} />;
  return (
    <StudioShellProvider value={studioCtxValue}>
      <StudioPlaybackProvider value={studioCtxValue}>
        <PanelLayoutProvider value={panelLayout}>
            <FileManagerProvider value={fileManager}>
              <DomEditProvider value={domEditSession}>
                <div
                  className="flex flex-col h-full w-full bg-neutral-950 relative"
                  onDragOver={fileDrop.onDragOver}
                  onDrop={fileDrop.onDrop}
                >
                  {previewPersistence.domEditSaveQueuePaused && !externalFileChanges.blocked && (
                    <SaveQueuePausedBanner
                      message={previewPersistence.domEditSaveQueuePaused}
                      onRetry={previewPersistence.resetDomEditSaveQueueBreaker}
                    />
                  )}
                  <ExternalFileConflictBanner coordinator={externalFileChanges} />
                  <EditorShell
                    left={
                      <StudioLeftSidebar
                        leftSidebarRef={leftSidebarRef}
                        masterComposition={masterCompPath}
                        onSelectComposition={handleSelectComposition}
                        onAddBlock={handleAddBlock}
                        onPreviewBlock={setBlockPreview}
                        onAddAssetToTimeline={handleAddAssetAtPlayhead}
                        onAddCompositionToTimeline={handleAddCompositionAtPlayhead}
                      />
                    }
                    right={
                      panelLayout.effectiveRightCollapsed ? (
                        <StudioRightSidebarRail
                          onShow={() => panelLayout.setRightCollapsed(false)}
                        />
                      ) : (
                        <StudioRightPanel
                          designPanelActive={designPanelActive}
                          activeBlockParams={activeBlockParams}
                          onCloseBlockParams={() => {
                            setActiveBlockParams(null);
                            panelLayout.setRightPanelTab("design");
                          }}
                          recordingState={gestureState}
                          recordingDuration={gestureRecording.recordingDuration}
                          onToggleRecording={handleToggleRecording}
                          reloadPreview={reloadPreview}
                          domEditSaveTimestampRef={domEditSaveTimestampRef}
                          recordEdit={editHistory.recordEdit}
                          onToggleElementHidden={timelineEditing.handleToggleElementHidden}
                          onAutoGroupCarveSources={timelineEditing.handleAutoGroupCarveSources}
                          onAddMediaOverlay={handleAddMediaOverlay}
                        />
                      )
                    }
                    timelineToolbar={timelineToolbar}
                    renderClipContent={renderClipContent}
                    handleTimelineElementDelete={timelineEditing.handleTimelineElementDelete}
                    handleTimelineAssetDrop={timelineEditing.handleTimelineAssetDrop}
                    handleTimelineBlockDrop={handleTimelineBlockDrop}
                    handleTimelineCompositionDrop={timelineEditing.handleTimelineCompositionDrop}
                    handlePreviewBlockDrop={handlePreviewBlockDrop}
                    handleTimelineFileDrop={timelineEditing.handleTimelineFileDrop}
                    handleTimelineElementMove={timelineEditing.handleTimelineElementMove}
                    handleTimelineElementsMove={handleTimelineElementsMove}
                    handleTimelineElementResize={timelineEditing.handleTimelineElementResize}
                    handleTimelineGroupResize={timelineEditing.handleTimelineGroupResize}
                    handleToggleTrackHidden={timelineEditing.handleToggleTrackHidden}
                    setAudioGroupAttribute={timelineEditing.setAudioGroupAttribute}
                    handleGroupClips={timelineEditing.handleAutoGroupCarveSources}
                    setElementFxAttribute={timelineEditing.setElementFxAttribute}
                    handleBlockedTimelineEdit={timelineEditing.handleBlockedTimelineEdit}
                    handleTimelineElementSplit={timelineEditing.handleTimelineElementSplit}
                    handleRazorSplit={timelineEditing.handleRazorSplit}
                    handleRazorSplitAll={timelineEditing.handleRazorSplitAll}
                    setCompIdToSrc={setCompIdToSrc}
                    setCompositionLoading={setCompositionLoading}
                    shouldShowMotionPath={shouldShowMotionPath}
                    shouldShowSelectedDomBounds={shouldShowSelectedDomBounds}
                    isGestureRecording={gestureState === "recording"}
                    recordingState={gestureState}
                    onToggleRecording={handleToggleRecording}
                    blockPreview={blockPreview}
                    gestureOverlay={
                      gestureState === "recording" && previewIframe ? (
                        <GestureTrailOverlay
                          samples={gestureRecording.samplesRef.current}
                          sampleCount={gestureRecording.samplesRef.current.length}
                          trail={gestureRecording.trailRef.current}
                          canvasRect={canvasRectRef.current!}
                          compositionSize={compositionDimensions ?? undefined}
                          mode="recording"
                        />
                      ) : undefined
                    }
                  />
                  <StudioOverlays
                    toasts={toasts}
                    dismissToast={dismissToast}
                  />
                </div>
              </DomEditProvider>
            </FileManagerProvider>
        </PanelLayoutProvider>
      </StudioPlaybackProvider>
    </StudioShellProvider>
  );
}
