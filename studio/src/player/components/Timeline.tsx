import { useRef, useMemo, useCallback, useState, memo } from "react";
import { useAdjustedBeatAnalysis, useMusicBeatAnalysis } from "../../hooks/useMusicBeatAnalysis";
import { usePlayerStore, type TimelineElement } from "../store/playerStore";
import { useExpandedTimelineElements } from "../hooks/useExpandedTimelineElements";
import { defaultTimelineTheme } from "./timelineTheme";
import { useTimelineRangeSelection } from "./useTimelineRangeSelection";
import { useTimelinePlayhead } from "./useTimelinePlayhead";
import { useTimelineZoom } from "./useTimelineZoom";
import { useTimelineAssetDrop } from "./timelineDragDrop";
import { TimelineEmptyState } from "./TimelineEmptyState";
import { TimelineCanvas } from "./TimelineCanvas";
import { type KeyframeDiamondContextMenuState } from "./KeyframeDiamondContextMenu";
import { useTimelineClipDrag } from "./useTimelineClipDrag";
import { TimelineOverlays, type ClipContextMenuState } from "./TimelineOverlays";
import { useTimelineEditPinning } from "./useTimelineEditPinning";
import { useTimelineStackingSync } from "./useTimelineStackingSync";
import { useTimelineGeometry } from "./useTimelineGeometry";
import { useAutoExpandKeyframedClips } from "./useAutoExpandKeyframedClips";
import { GUTTER, LABEL_COL_W } from "./timelineLayout";
import { useTimelineScrollViewport } from "./useTimelineScrollViewport";
import { useResolvedTimelineEditCallbacks } from "./useResolvedTimelineEditCallbacks";
import type { TimelineProps } from "./TimelineTypes";
import {
  getTrackStyle,
  mergeTimelineLaneCounts,
  padTimelineTrackOrder,
  useTimelineDisplayLayout,
  useTimelineTrackLayout,
} from "./useTimelineTrackLayout";
import { useTimelineKeyframeHandlers } from "./useTimelineKeyframeHandlers";
import { useTrackGapMenu } from "./useTrackGapMenu";
import { useTimelineGapHighlights } from "./useTimelineGapHighlights";
import { TimelineRazorGuide, useTimelineRazorInteraction } from "./TimelineRazorInteraction";
import { useTimelinePerformanceTelemetry } from "./useTimelinePerformanceTelemetry";
import {
  getEffectiveTimelineDuration,
  getTimelinePreviewElement,
} from "./timelineViewModel";
import { useTimelineShiftModifier } from "./useTimelineShiftModifier";
import { useTimelineTicks } from "./useTimelineTicks";
import { getTimelineElementIdentity } from "../lib/timelineElementHelpers";
import { useTimelineClipRenderWindow } from "./useTimelineClipRenderWindow";
import { useTimelineActiveClips } from "./useTimelineActiveClips";
import { useTimelineLaneMoveRefresh } from "./useTimelineLaneMoveRefresh";
import { useTimelineLogicalFocus } from "./useTimelineLogicalFocus";
import { useDomEditSelectionContextOptional } from "../../contexts/DomEditContext";
import {
  buildNativeTimelineLaneProjectionMap,
} from "./nativeTimelinePropertyLaneBridge";
import { buildNativeTimelineEffectMap } from "./timelineAttachedEffects";

export {
  shouldAutoScrollTimeline,
  getTimelineScrollLeftForZoomTransition,
  getTimelineScrollLeftForZoomAnchor,
  getTimelinePlaybackFollowScrollLeft,
  getTimelinePlayheadLeft,
  getTimelineCanvasHeight,
  resolveTimelineAssetDrop,
  shouldHandleTimelineDeleteKey,
  getDefaultDroppedTrack,
} from "./timelineLayout";
export { formatTimelineTickLabel, generateTicks } from "./timelineRulerGeometry";

export {
  getTimelineScrollTopForGeometryChange,
  getTimelineVisibleTimeRange,
} from "./timelineViewportGeometry";
export const Timeline = memo(function Timeline({
  onSeek,
  onDrillDown,
  renderClipContent,
  renderClipOverlay,
  onFileDrop,
  onAssetDrop,
  onBlockDrop,
  onCompositionDrop,
  onDeleteElement: _onDeleteElement,
  onMoveElement: onMoveElementOverride,
  onMoveElements: onMoveElementsOverride,
  onResizeElement: onResizeElementOverride,
  onResizeElements: onResizeElementsOverride,
  onBlockedEditAttempt: onBlockedEditAttemptOverride,
  onSplitElement: onSplitElementOverride,
  onSelectElement,
  theme: themeOverrides,
  sessionEpoch = 0,
}: TimelineProps = {}) {
  const {
    onMoveElement,
    onMoveElements,
    onResizeElement,
    onResizeElements,
    onBlockedEditAttempt,
    onSplitElement,
    onRazorSplitAll,
    onDeleteKeyframe,
    onDeleteAllKeyframes,
    onMoveKeyframeToPlayhead,
    onSetKeyframeInterpolation,
    onMoveKeyframe,
    onSetElementAttributeQuiet,
  } = useResolvedTimelineEditCallbacks({
    onMoveElement: onMoveElementOverride,
    onMoveElements: onMoveElementsOverride,
    onResizeElement: onResizeElementOverride,
    onResizeElements: onResizeElementsOverride,
    onBlockedEditAttempt: onBlockedEditAttemptOverride,
    onSplitElement: onSplitElementOverride,
  });
  const theme = useMemo(() => ({ ...defaultTimelineTheme, ...themeOverrides }), [themeOverrides]);
  const refreshAfterLaneMove = useTimelineLaneMoveRefresh();
  useMusicBeatAnalysis();
  const rawElements = usePlayerStore((s) => s.elements);
  const expandedElements = useExpandedTimelineElements();
  const adjustedBeatAnalysis = useAdjustedBeatAnalysis();
  const duration = usePlayerStore((s) => s.duration);
  const timeDisplayMode = usePlayerStore((s) => s.timeDisplayMode);
  const timelineReady = usePlayerStore((s) => s.timelineReady);
  const selectedElementId = usePlayerStore((s) => s.selectedElementId);
  const selectedElementIds = usePlayerStore((s) => s.selectedElementIds);
  const focusedEaseSegment = usePlayerStore((s) => s.focusedEaseSegment);
  const gsapAnimations = usePlayerStore((s) => s.gsapAnimations);
  const nativeProjectDocument =
    useDomEditSelectionContextOptional()?.nativeProjectDocument ?? null;
  const nativeLaneProjections = useMemo(
    () => buildNativeTimelineLaneProjectionMap(nativeProjectDocument, expandedElements),
    [expandedElements, nativeProjectDocument],
  );
  const nativeEffectMap = useMemo(
    () => buildNativeTimelineEffectMap(nativeProjectDocument, expandedElements),
    [expandedElements, nativeProjectDocument],
  );
  const timelineLaneCountMap = useMemo(
    () => mergeTimelineLaneCounts(gsapAnimations, nativeLaneProjections),
    [gsapAnimations, nativeLaneProjections],
  );
  // Every strip keeps its full title/control column. The red pre-roll surface
  // follows it, and t=0 begins only after both fixed-width regions.
  const contentOrigin = LABEL_COL_W + GUTTER;
  const contentGutter = GUTTER;
  const setSelectedElementId = usePlayerStore((s) => s.setSelectedElementId);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const { zoomMode, manualZoomPercent, setZoomMode, setManualZoomPercent } = useTimelineZoom();
  const playheadRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTool = usePlayerStore((s) => s.activeTool);
  const [hoveredClip, setHoveredClip] = useState<string | null>(null);
  const isDragging = useRef(false);
  const shiftHeld = useTimelineShiftModifier();
  const [kfContextMenu, setKfContextMenu] = useState<KeyframeDiamondContextMenuState | null>(null);
  const [clipContextMenu, setClipContextMenu] = useState<ClipContextMenuState | null>(null);
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
  }, []);
  const lastScrollLeftRef = useRef(0);
  const effectiveDuration = useMemo(
    () => getEffectiveTimelineDuration(duration, rawElements),
    [duration, rawElements],
  );
  const keyframeCache = usePlayerStore((s) => s.keyframeCache);
  useAutoExpandKeyframedClips(gsapAnimations, timelineLaneCountMap);
  const {
    tracks,
    trackStyles,
    trackOrder,
    trackOrderRef,
    laneCounts,
    rowGeometry,
    rowGeometryRef,
    groups,
    trackGroupOf,
  } = useTimelineTrackLayout(
    expandedElements,
    gsapAnimations,
    selectedElementId,
    selectedElementIds,
    timelineLaneCountMap,
    nativeEffectMap,
  );
  const baselineDisplayTrackOrder = useMemo(
    () => padTimelineTrackOrder(trackOrder, expandedElements.map((element) => element.track)),
    [expandedElements, trackOrder],
  );
  const displayTrackOrderRef = useRef(baselineDisplayTrackOrder);
  displayTrackOrderRef.current = baselineDisplayTrackOrder;
  const expandedElementsRef = useRef(expandedElements);
  expandedElementsRef.current = expandedElements;
  const ppsRef = useRef(100);
  const durationRef = useRef(effectiveDuration);
  durationRef.current = effectiveDuration;
  const fitPpsRef = useRef(100);
  const {
    pinZoomBeforeEdit,
    pinnedOnMoveElement,
    pinnedOnMoveElements,
    pinnedOnResizeElement,
    pinnedOnResizeElements,
    pinnedOnFileDrop,
    pinnedOnAssetDrop,
    pinnedOnBlockDrop,
    pinnedOnCompositionDrop,
  } = useTimelineEditPinning({
    ppsRef,
    fitPpsRef,
    onMoveElement,
    onMoveElements,
    onResizeElement,
    onResizeElements,
    onFileDrop,
    onAssetDrop,
    onBlockDrop,
    onCompositionDrop,
  });
  const { readClipZIndex, applyStackingPatches, zSyncEnabled } = useTimelineStackingSync({
    expandedElementsRef,
    expandedElements,
  });
  const {
    gapMenuModel,
    gapHighlight,
    setHoveredGapAction,
    openGapMenu,
    dismissGapMenu,
    closeTrackGap,
    closeAllTrackGaps,
  } = useTrackGapMenu({
    tracks,
    expandedElementsRef,
    trackOrderRef,
    onMoveElement: pinnedOnMoveElement,
    onMoveElements: pinnedOnMoveElements,
  });

  const {
    draggedClip,
    setDraggedClip,
    resizingClip,
    setResizingClip,
    blockedClipRef,
    suppressClickRef,
  } = useTimelineClipDrag({
    scrollRef,
    ppsRef,
    durationRef,
    trackOrderRef: displayTrackOrderRef,
    rowGeometryRef,
    onMoveElement: pinnedOnMoveElement,
    onMoveElements: pinnedOnMoveElements,
    onResizeElement: pinnedOnResizeElement,
    onResizeElements: pinnedOnResizeElements,
    onBlockedEditAttempt,
    readZIndex: zSyncEnabled ? readClipZIndex : undefined,
    onStackingPatches: zSyncEnabled ? applyStackingPatches : undefined,
    refreshAfterLaneMove,
    sessionEpoch,
    frameRate: nativeProjectDocument?.frameRate,
  });

  const assetDrop = useTimelineAssetDrop({
    scrollRef,
    ppsRef,
    durationRef,
    trackOrderRef: displayTrackOrderRef,
    rowGeometryRef,
    contentOrigin,
    onFileDrop: pinnedOnFileDrop,
    onAssetDrop: pinnedOnAssetDrop,
    onBlockDrop: pinnedOnBlockDrop,
    onCompositionDrop: pinnedOnCompositionDrop,
    sessionEpoch,
  });
  const displayLayout = useTimelineDisplayLayout(
    draggedClip,
    baselineDisplayTrackOrder,
    rowGeometry,
  );
  const resizingElementIds =
    resizingClip?.groupPreview?.map((change) => change.key) ??
    (resizingClip ? [getTimelineElementIdentity(resizingClip.element)] : undefined);
  const { recordTimelineScroll } = useTimelinePerformanceTelemetry({
    totalClipCount: expandedElements.length,
    totalRowCount: displayLayout.displayTrackOrder.length,
    zoomMode,
  });
  const { viewport, setScrollRef, syncScrollViewport } = useTimelineScrollViewport(scrollRef);
  const { pps, fitPps, displayContentWidth, displayDuration, zoomModeRef, manualZoomPercentRef } =
    useTimelineGeometry({
      viewportWidth: viewport.clientWidth,
      effectiveDuration,
      zoomMode,
      manualZoomPercent,
      ppsRef,
      fitPpsRef,
      draggedClip,
      resizingClip,
      expandedElements,
      isDragging,
      scrollRef,
      lastScrollLeftRef,
      contentOrigin,
    });
  const timelineFocus = useTimelineLogicalFocus({
    scrollRef,
    tracks,
    layout: displayLayout,
    laneCounts,
    selectedElementId,
    selectedElementIds,
    groups,
    trackGroupOf,
    gsapAnimations,
    nativeLaneProjections,
    elements: expandedElements,
    pixelsPerSecond: pps,
    contentOrigin,
    allowHorizontal: zoomMode === "manual",
    viewport,
    sessionEpoch,
    draggedRowKey: draggedClip?.started ? draggedClip.previewTrack : undefined,
    resizingElementIds,
    clipContextMenuRowKey: clipContextMenu?.element.track,
    keyframeContextMenuRowKey: kfContextMenu?.element.track,
    lastScrollLeftRef,
    syncScrollViewport,
  });
  const selectedKeyframes = usePlayerStore((s) => s.selectedKeyframes);
  const toggleSelectedKeyframe = usePlayerStore((s) => s.toggleSelectedKeyframe);
  const { onClickKeyframe, onSelectSegment, onShiftClickKeyframe, onContextMenuKeyframe } =
    useTimelineKeyframeHandlers({
      expandedElements,
      keyframeCache,
      onSelectElement,
      onSeek,
      setSelectedElementId,
      setKfContextMenu,
      toggleSelectedKeyframe,
    });

  const { clipIndex, renderTimeRange, visibleTimeRange, pinnedClipIdentities } =
    useTimelineClipRenderWindow({
      tracks,
      viewport,
      pixelsPerSecond: pps,
      contentOrigin,
      duration: displayDuration,
      selectedElementId: selectedElementId ?? undefined,
      draggedElementId: draggedClip ? getTimelineElementIdentity(draggedClip.element) : undefined,
      resizingElementIds,
      focusedElementId: timelineFocus.pinnedElementId,
      focusedEaseElementId: focusedEaseSegment?.elementId,
      clipContextMenuElementId: clipContextMenu
        ? getTimelineElementIdentity(clipContextMenu.element)
        : undefined,
      keyframeContextMenuElementId: kfContextMenu
        ? getTimelineElementIdentity(kfContextMenu.element)
        : undefined,
    });
  useTimelineActiveClips({
    scrollRef,
    currentTime,
    clipStateVersion: renderTimeRange,
    elementStateVersion: expandedElements,
  });
  const laneGapStrips = useTimelineGapHighlights({
    gapHighlight,
    tracks,
    selectedElementId,
    selectedElementIds,
    expandedElements,
    dragActive: draggedClip?.started === true || resizingClip != null,
    displayDuration,
  });

  const { seekFromX, autoScrollDuringDrag, dragScrollRaf } = useTimelinePlayhead({
    playheadRef,
    scrollRef,
    ppsRef,
    durationRef,
    isDragging,
    currentTime,
    zoomMode,
    manualZoomPercent,
    zoomModeRef,
    manualZoomPercentRef,
    fitPps,
    fitPpsRef,
    effectiveDuration,
    pps,
    timelineReady,
    elementsLength: expandedElements.length,
    setZoomMode,
    setManualZoomPercent,
    onSeek,
    contentOrigin,
  });
  const { razorGuideX, updateRazorGuide, clearRazorGuide, splitAllAtPointer } =
    useTimelineRazorInteraction({
      active: activeTool === "razor",
      scrollRef,
      contentOrigin,
      pixelsPerSecond: pps,
      onSplitAll: onRazorSplitAll,
    });

  const {
    marqueeRect,
    isScrubbing,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  } = useTimelineRangeSelection({
    scrollRef,
    ppsRef,
    effectiveDuration,
    pps,
    onSeek,
    seekFromX,
    autoScrollDuringDrag,
    dragScrollRaf,
    isDragging,
    elementsRef: expandedElementsRef,
    clipIndex,
    rowGeometryRef,
    onSelectElement,
    contentOrigin,
    sessionEpoch,
  });
  const { major, minor, majorTickInterval } = useTimelineTicks(
    displayDuration,
    pps,
    timeDisplayMode,
    timelineFocus.rowVirtualizationActive ? renderTimeRange : undefined,
  );

  const getPreviewElement = useCallback(
    (element: TimelineElement): TimelineElement => getTimelinePreviewElement(element, resizingClip),
    [resizingClip],
  );

  if (!timelineReady || expandedElements.length === 0) {
    return (
      <TimelineEmptyState
        isDragOver={assetDrop.isDragOver}
        onFileDrop={!!onFileDrop}
        onDragOver={assetDrop.handleAssetDragOver}
        onDragLeave={assetDrop.handleAssetDragLeave}
        onDrop={assetDrop.handleAssetDrop}
      />
    );
  }

  return (
    <div
      ref={setContainerRef}
      aria-label="Timeline"
      data-timeline-element-count={expandedElements.length}
      className={`relative border-t select-none h-full overflow-hidden ${assetDrop.isDragOver ? "outline outline-1 outline-studio-accent/60 outline-offset-[-1px]" : ""} ${activeTool === "razor" ? "cursor-crosshair" : shiftHeld ? "cursor-crosshair" : "cursor-default"}`}
      onMouseMove={updateRazorGuide}
      onMouseLeave={clearRazorGuide}
      style={{
        touchAction: "pan-x pan-y",
        background: theme.shellBackground,
        borderColor: theme.shellBorder,
      }}
    >
      <div
        ref={setScrollRef}
        // Stable owner for gestures that must survive virtual row/clip unmounts.
        data-timeline-scroll-viewport
        data-timeline-auto-scroll-left-inset={LABEL_COL_W}
        data-timeline-origin-gap-hidden="false"
        tabIndex={-1}
        className={`${zoomMode === "fit" ? "overflow-x-hidden" : "overflow-x-auto"} overflow-y-auto h-full outline-none`}
        onScroll={(e) => {
          e.currentTarget.dataset.timelineOriginGapHidden =
            e.currentTarget.scrollLeft > 0 ? "true" : "false";
          lastScrollLeftRef.current = e.currentTarget.scrollLeft; // restored across post-edit reload
          recordTimelineScroll(e.currentTarget);
          syncScrollViewport(e.currentTarget, true);
        }}
        {...timelineFocus.timelineFocusProps}
        onDragOver={assetDrop.handleAssetDragOver}
        onDragLeave={assetDrop.handleAssetDragLeave}
        onDrop={assetDrop.handleAssetDrop}
        onPointerDown={(e) => {
          // Interactive controls own their clicks; scrubbing would preventDefault and eat them.
          if (e.target instanceof Element && e.target.closest("button, input, select, a")) return;
          if (splitAllAtPointer(e)) return;
          handlePointerDown(e);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerCancel}
      >
        <TimelineCanvas
          major={major}
          minor={minor}
          pps={pps}
          contentOrigin={contentOrigin}
          contentGutter={contentGutter}
          trackContentWidth={displayContentWidth}
          totalH={displayLayout.totalH}
          effectiveDuration={effectiveDuration}
          majorTickInterval={majorTickInterval}
          marqueeRect={marqueeRect}
          laneGapStrips={laneGapStrips}
          theme={theme}
          displayTrackOrder={displayLayout.displayTrackOrder}
          rowHeights={displayLayout.displayRowHeights}
          rowGeometry={displayLayout.rowGeometry}
          virtualRows={timelineFocus.virtualRows}
          logicalRows={timelineFocus.logicalRows}
          focusedTargetId={timelineFocus.focusedTargetId}
          rowsVirtualized={timelineFocus.rowVirtualizationActive}
          clipIndex={clipIndex}
          renderTimeRange={renderTimeRange}
          visibleTimeRange={visibleTimeRange}
          pinnedClipIdentities={pinnedClipIdentities}
          trackOrder={trackOrder}
          tracks={tracks}
          trackStyles={trackStyles}
          groups={groups}
          laneCounts={laneCounts}
          nativeLaneProjections={nativeLaneProjections}
          nativeEffectMap={nativeEffectMap}
          selectedElementId={selectedElementId}
          selectedElementIds={selectedElementIds}
          hoveredClip={hoveredClip}
          draggedClip={draggedClip}
          resizingClip={resizingClip}
          isScrubbing={isScrubbing}
          blockedClipRef={blockedClipRef}
          suppressClickRef={suppressClickRef}
          scrollRef={scrollRef}
          renderClipContent={renderClipContent}
          renderClipOverlay={renderClipOverlay}
          playheadRef={playheadRef}
          onDrillDown={onDrillDown}
          onSelectElement={onSelectElement}
          setHoveredClip={setHoveredClip}
          setResizingClip={setResizingClip}
          setDraggedClip={setDraggedClip}
          setSelectedElementId={setSelectedElementId}
          getPreviewElement={getPreviewElement}
          getTrackStyle={getTrackStyle}
          keyframeCache={keyframeCache}
          gsapAnimations={gsapAnimations}
          selectedKeyframes={selectedKeyframes}
          currentTime={currentTime}
          onSeek={onSeek}
          beatAnalysis={adjustedBeatAnalysis}
          onSelectSegment={onSelectSegment}
          onClickKeyframe={onClickKeyframe}
          onShiftClickKeyframe={onShiftClickKeyframe}
          onMoveKeyframe={onMoveKeyframe}
          onContextMenuKeyframe={onContextMenuKeyframe}
          onContextMenuClip={(e, el) => {
            e.preventDefault();
            setSelectedElementId(el.key ?? el.id);
            onSelectElement?.(el);
            dismissGapMenu();
            setClipContextMenu({
              x: e.clientX,
              y: e.clientY,
              element: el,
              sessionEpoch: usePlayerStore.getState().timelineSessionEpoch,
            });
          }}
          onContextMenuLane={(e, track, time) => {
            if (draggedClip?.started || resizingClip) return;
            setClipContextMenu(null);
            openGapMenu({ x: e.clientX, y: e.clientY, track, time });
          }}
        />
        {activeTool === "razor" && razorGuideX !== null && <TimelineRazorGuide x={razorGuideX} />}
      </div>
      <TimelineOverlays
        elements={expandedElements}
        elementsRef={expandedElementsRef}
        theme={theme}
        kfContextMenu={kfContextMenu}
        setKfContextMenu={setKfContextMenu}
        onDeleteKeyframe={onDeleteKeyframe}
        onDeleteAllKeyframes={onDeleteAllKeyframes}
        onMoveKeyframeToPlayhead={onMoveKeyframeToPlayhead}
        onSetKeyframeInterpolation={onSetKeyframeInterpolation}
        clipContextMenu={clipContextMenu}
        setClipContextMenu={setClipContextMenu}
        currentTime={currentTime}
        onSplitElement={onSplitElement}
        onSetElementAttributeQuiet={onSetElementAttributeQuiet}
        pinZoomBeforeEdit={pinZoomBeforeEdit}
        onDeleteElement={_onDeleteElement}
        gapContextMenu={gapMenuModel}
        onDismissGapContextMenu={dismissGapMenu}
        onCloseTrackGap={closeTrackGap}
        onCloseAllTrackGaps={closeAllTrackGaps}
        onHoverGapAction={setHoveredGapAction}
      />
    </div>
  );
});
