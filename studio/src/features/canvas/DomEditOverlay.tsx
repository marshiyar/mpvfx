import { memo, useEffect, useMemo, useRef } from "react";
import { type DomEditSelection } from "./domEditing";
import { eventIsInsideProgramFrame, resolveProgramFrameClipPath, type DomEditOverlayProps } from "./domEditOverlayContract";
import { useMarqueeGestures } from "./marqueeCommit";
import { MarqueeOverlay } from "./MarqueeOverlay";
import {
  resolveDomEditGroupOverlayRect,
  selectionCacheKey,
} from "./domEditOverlayGeometry";
import {
  useZOrderCrossedFlash,
  ZOrderCrossedFlash,
} from "./useZOrderCrossedFlash";
import { useCanvasContextMenuState } from "./useCanvasContextMenuState";
import {
  type BlockedMoveState,
  type FocusableDomEditOverlay,
  type GestureState,
  type GroupGestureState,
  focusDomEditOverlayElement,
  resolveShiftClickCandidate,
} from "./domEditOverlayGestures";
import { useDomEditOverlayRects } from "./useDomEditOverlayRects";
import { ChildRectOutlines } from "./ChildRectOutlines";
import { createDomEditOverlayGestureHandlers } from "./useDomEditOverlayGestures";
import { useDomEditNudge } from "./useDomEditNudge";
import { SnapGuideOverlay, type SnapGuidesState } from "./SnapGuideOverlay";
import { GridOverlay } from "./GridOverlay";
import {
  DomEditGroupChrome,
  DomEditSelectionChrome,
} from "./DomEditSelectionChrome";
import { hugOrientedRectForElement } from "./domEditOverlayCrop";
import {
  readDomEditSelectionShapeStyles,
  resolveBoxChromeClass,
} from "./domEditOverlayShape";
import { useDomEditCompositionRect } from "./useDomEditCompositionRect";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { useInlineTextEditing } from "./useInlineTextEditing";
import { getPreviewTargetFromPointer } from "../preview/studioPreviewHelpers";
import { logSelect } from "../../lib/selectDebug";

// Re-exports for external consumers — preserving existing import paths.
export {
  filterNestedDomEditGroupItems,
  resolveDomEditCoordinateScale,
  resolveDomEditGroupOverlayRect,
} from "./domEditOverlayGeometry";
export {
  focusDomEditOverlayElement,
  hasDomEditRotationChanged,
  resolveDomEditRotationGesture,
} from "./domEditOverlayGestures";
export type { DomEditGroupPathOffsetCommit } from "./domEditOverlayGestures";
export { resolveProgramFrameClipPath } from "./domEditOverlayContract";

// fallow-ignore-next-line complexity
export const DomEditOverlay = memo(function DomEditOverlay({
  iframeRef,
  activeCompositionPath,
  selection,
  groupSelections = [],
  hoverSelection,
  allowCanvasMovement = true,
  cropActive = false,
  cropDisabled = false,
  cropLinks,
  cropInsets,
  onCropInsetsPreview,
  onCanvasMouseDown,
  onCanvasPointerMove,
  onCanvasPointerLeave,
  onSelectionChange,
  onBlockedMove,
  gridVisible = false,
  gridSpacing = 50,
  onManualDragStart,
  onPathOffsetCommit,
  onGroupPathOffsetCommit,
  onBoxSizeCommit,
  onRotationCommit,
  onMarqueeSelect,
  onDeleteSelection,
  onApplyZIndex,
}: DomEditOverlayProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const onMarqueeSelectRef = useRef(onMarqueeSelect);
  onMarqueeSelectRef.current = onMarqueeSelect;

  const gestureRef = useRef<GestureState | null>(null);
  const groupGestureRef = useRef<GroupGestureState | null>(null);
  const blockedMoveRef = useRef<BlockedMoveState | null>(null);
  const suppressNextBoxClickRef = useRef(false);
  const suppressNextBoxMouseDownRef = useRef(false);
  const suppressNextOverlayMouseDownRef = useRef(false);
  const snapGuidesRef = useRef<SnapGuidesState | null>(null);
  const rafPausedRef = useRef(false);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // Brief highlight on the sibling a forward/backward z step crossed — drawn
  // in this studio overlay, never in the iframe DOM (see useZOrderCrossedFlash).
  const { zOrderFlashRect, handleZOrderCrossed } = useZOrderCrossedFlash({
    overlayRef,
    iframeRef,
  });

  const activeCompositionPathRef = useRef(activeCompositionPath);
  activeCompositionPathRef.current = activeCompositionPath;
  const groupSelectionsRef = useRef(groupSelections);
  groupSelectionsRef.current = groupSelections;
  const hoverSelectionRef = useRef(hoverSelection);
  hoverSelectionRef.current = hoverSelection;

  // Double-click an element to edit its text where it sits.
  const inlineText = useInlineTextEditing(selectionRef);
  const onPathOffsetCommitRef = useRef(onPathOffsetCommit);
  onPathOffsetCommitRef.current = onPathOffsetCommit;
  const onGroupPathOffsetCommitRef = useRef(onGroupPathOffsetCommit);
  onGroupPathOffsetCommitRef.current = onGroupPathOffsetCommit;
  const onBoxSizeCommitRef = useRef(onBoxSizeCommit);
  onBoxSizeCommitRef.current = onBoxSizeCommit;
  const onRotationCommitRef = useRef(onRotationCommit);
  onRotationCommitRef.current = onRotationCommit;
  const onBlockedMoveRef = useRef(onBlockedMove);
  onBlockedMoveRef.current = onBlockedMove;
  const onManualDragStartRef = useRef(onManualDragStart);
  onManualDragStartRef.current = onManualDragStart;
  const onCanvasPointerMoveRef = useRef(onCanvasPointerMove);
  onCanvasPointerMoveRef.current = onCanvasPointerMove;
  const onCanvasPointerLeaveRef = useRef(onCanvasPointerLeave);
  onCanvasPointerLeaveRef.current = onCanvasPointerLeave;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  const {
    selectionElement,
    selectionElementKey,
    overlayRect,
    overlayRectRef,
    setOverlayRect,
    hoverRect,
    groupOverlayItems,
    groupOverlayItemsRef,
    setGroupOverlayItems,
    childRects,
  } = useDomEditOverlayRects({
    iframeRef,
    overlayRef,
    selectionRef,
    activeCompositionPathRef,
    groupSelectionsRef,
    hoverSelectionRef,
    rafPausedRef,
  });

  // Source writes may replace the iframe node while preserving the logical
  // selection. Geometry is measured from that replacement, so every crop read
  // and gesture must target the same live node rather than the detached node
  // retained by the parent selection snapshot.
  const liveSelection = useMemo(
    () =>
      selection &&
      selectionElement &&
      selectionElementKey === selectionCacheKey(selection) &&
      selection.element !== selectionElement
        ? { ...selection, element: selectionElement }
        : selection,
    [selection, selectionElement, selectionElementKey],
  );
  selectionRef.current = liveSelection;

  const selectionShapeStyles = readDomEditSelectionShapeStyles(liveSelection);

  const compRect = useDomEditCompositionRect({ iframeRef, overlayRef });
  const compRectRef = useRef(compRect);
  compRectRef.current = compRect;

  const boxClipPath = selectionShapeStyles.clipPath;
  const boxChromeClass = resolveBoxChromeClass(boxClipPath);
  // Outside explicit Crop mode, the media's committed crop is its visible
  // geometry: border, handles, hit area, and rotate control hug those margins.
  // Crop mode itself still receives the full source frame so hidden pixels can
  // be recovered and Reset remains genuinely non-destructive.
  const selectionChromeRect = useMemo(
    () =>
      liveSelection && overlayRect && !cropActive
        ? hugOrientedRectForElement(overlayRect, liveSelection.element)
        : overlayRect,
    [cropActive, cropInsets, liveSelection, overlayRect],
  );

  const gestures = createDomEditOverlayGestureHandlers({
    overlayRef,
    iframeRef,
    boxRef,
    selectionRef,
    hoverSelectionRef,
    overlayRectRef,
    groupOverlayItemsRef,
    gestureRef,
    groupGestureRef,
    blockedMoveRef,
    rafPausedRef,
    suppressNextBoxClickRef,
    setOverlayRect,
    setGroupOverlayItems,
    onBlockedMoveRef,
    onManualDragStartRef,
    onPathOffsetCommitRef,
    onGroupPathOffsetCommitRef,
    onBoxSizeCommitRef,
    onRotationCommitRef,
    onCanvasPointerMoveRef,
    onCanvasMouseDown,
    snapGuidesRef,
  });

  // Arrow-key nudge (1px, Shift = 10px) — commits through the same
  // path-offset callbacks as a drag, one undo entry per key burst.
  const { flushNudge } = useDomEditNudge({
    selection,
    groupSelections,
    allowCanvasMovement,
    selectionRef,
    overlayRectRef,
    compositionRectRef: compRectRef,
    groupOverlayItemsRef,
    gestureRef,
    groupGestureRef,
    blockedMoveRef,
    onManualDragStartRef,
    onPathOffsetCommitRef,
    onGroupPathOffsetCommitRef,
  });

  const marquee = useMarqueeGestures({
    iframeRef,
    overlayRef,
    activeCompositionPathRef,
    onMarqueeSelectRef,
    selectionRef,
    gestures,
  });

  const cancelCanvasGesture = () => {
    if (!gestureRef.current && !groupGestureRef.current && !blockedMoveRef.current &&
      !marquee.marqueeRef.current) return false;
    suppressNextBoxClickRef.current = true;
    marquee.onPointerCancel();
    return true;
  };
  const cancelCanvasGestureRef = useRef(cancelCanvasGesture);
  cancelCanvasGestureRef.current = cancelCanvasGesture;
  useEffect(() => () => {
    cancelCanvasGestureRef.current();
  }, [liveSelection?.element, activeCompositionPath]);

  const selectionKey = useMemo(() => {
    if (!selection) return "none";
    return `${selection.sourceFile}:${selection.id ?? selection.selector ?? selection.label}:${selection.selectorIndex ?? 0}`;
  }, [selection]);

  const groupBounds = useMemo(
    () =>
      resolveDomEditGroupOverlayRect(
        groupOverlayItems.map((item) => item.rect),
      ),
    [groupOverlayItems],
  );
  const hasGroupSelection = groupSelections.length > 1;
  const groupCanMove =
    hasGroupSelection &&
    groupOverlayItems.length > 1 &&
    groupOverlayItems.every(
      (item) => item.selection.capabilities.canApplyManualOffset,
    );

  const handleOverlayMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!allowCanvasMovement) return;
    if (
      !eventIsInsideProgramFrame(event, overlayRef.current, compRectRef.current)
    )
      return;
    if (suppressNextOverlayMouseDownRef.current) {
      logSelect("mousedown-suppressed", { shift: event.shiftKey });
      suppressNextOverlayMouseDownRef.current = false;
      suppressNextBoxMouseDownRef.current = false;
      suppressNextBoxClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target as HTMLElement | null;
    const onBox = Boolean(
      target?.closest('[data-dom-edit-selection-box="true"]'),
    );
    logSelect("mousedown", { shift: event.shiftKey, onBox });
    if (onBox) return;
    // Only the program frame is editable. Content beyond it remains clipped
    // unless a future explicit overscan mode is introduced.
    onCanvasMouseDown(event, { hoverSelection: hoverSelectionRef.current });
    if (event.shiftKey) {
      suppressNextBoxMouseDownRef.current = true;
      suppressNextBoxClickRef.current = true;
    }
  };

  // fallow-ignore-next-line complexity
  const handleOverlayPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (!allowCanvasMovement || event.button !== 0) return;
    if (
      !eventIsInsideProgramFrame(event, overlayRef.current, compRectRef.current)
    )
      return;
    if (event.shiftKey) {
      const shiftIframe = iframeRef.current;
      const candidate = resolveShiftClickCandidate({
        cached: hoverSelectionRef.current,
        elementAtPoint: shiftIframe
          ? getPreviewTargetFromPointer(
              shiftIframe,
              event.clientX,
              event.clientY,
              activeCompositionPathRef.current,
            )
          : null,
      });
      // Not confident: fall through untouched — no preventDefault, no suppression —
      // so the mousedown path resolves this point instead of guessing here.
      if (!candidate) return;
      event.preventDefault();
      event.stopPropagation();
      suppressNextOverlayMouseDownRef.current = true;
      suppressNextBoxMouseDownRef.current = true;
      suppressNextBoxClickRef.current = true;
      onSelectionChangeRef.current(candidate, { additive: true });
      return;
    }

    // A second press on the same spot opens that element's text. This is the
    // press path that actually runs: the pointer handler prevents the default
    // on its way through, so the overlay's own mousedown never fires, and the
    // browser never pairs the presses into a dblclick either.
    if (inlineText.startFromPress(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-dom-edit-selection-box="true"]')) return;

    // Start marquee if clicking on empty canvas (no element under pointer).
    // The hover selection is an ASYNC cache: on a fast click (or when the
    // pointer was already resting over an element) it can still be empty while
    // an element IS under the pointer — starting a marquee here would swallow
    // the selection mousedown and the click would silently select nothing.
    // Confirm emptiness with a fresh SYNCHRONOUS hit-test before committing.
    if (
      !hoverSelectionRef.current &&
      onMarqueeSelectRef.current &&
      compRect.width > 0
    ) {
      const iframe = iframeRef.current;
      const freshTarget = iframe
        ? getPreviewTargetFromPointer(
            iframe,
            event.clientX,
            event.clientY,
            activeCompositionPathRef.current,
          )
        : null;
      if (freshTarget) return;
      const overlayEl = overlayRef.current;
      if (overlayEl) {
        const oRect = overlayEl.getBoundingClientRect();
        // Empty space inside the program frame may start a marquee. The viewer
        // surrounding the frame is navigation chrome, not an editable world.
        event.preventDefault();
        event.stopPropagation();
        suppressNextOverlayMouseDownRef.current = true;
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        const cx = event.clientX - oRect.left;
        const cy = event.clientY - oRect.top;
        marquee.marqueeRef.current = {
          startX: cx,
          startY: cy,
          currentX: cx,
          currentY: cy,
          pointerId: event.pointerId,
          pastThreshold: false,
        };
        return;
      }
    }
  };

  const handleBoxClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!allowCanvasMovement) return;
    if (gestureRef.current || groupGestureRef.current) return;
    if (suppressNextBoxClickRef.current) {
      suppressNextBoxClickRef.current = false;
      event.stopPropagation();
      return;
    }
    onCanvasMouseDown(event, { hoverSelection: hoverSelectionRef.current });
  };

  const suppressBoxMouseDown = (e: React.MouseEvent) => {
    if (!suppressNextBoxMouseDownRef.current) return;
    suppressNextBoxMouseDownRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  // Right-click state + handler: select the element under the pointer (if
  // needed), then open the menu; closes when the selection moves off-target.
  const { contextMenu, closeContextMenu, handleContextMenu } =
    useCanvasContextMenuState({
      selection: liveSelection,
      selectionRef,
      hoverSelectionRef,
      onCanvasPointerMoveRef,
      onSelectionChangeRef,
    });

  return (
    <div
      ref={overlayRef}
      // Standing aside is the only way the caret below can be reached, and is
      // what keeps selection, drag and marquee from firing mid-edit.
      className={`absolute inset-0 z-10 outline-none ${
        inlineText.editing ? "pointer-events-none" : "pointer-events-auto"
      }`}
      data-editing-text={inlineText.editing ? "true" : undefined}
      tabIndex={-1}
      aria-label="Composition canvas"
      // Cursor follows marquee rect *state* (re-renders), not the mutable ref.
      style={{
        ...(marquee.marqueeRect ? { cursor: "crosshair" } : {}),
        // Ordinary editor chrome stays inside the program frame. Explicit crop
        // mode alone exposes its 12px guide overhang so fitted media does not
        // hide handles behind the viewer boundary; pointer hit-tests below
        // still reject canvas interactions outside the program frame.
        clipPath: cropActive
          ? undefined
          : resolveProgramFrameClipPath(compRect),
      }}
      onPointerDownCapture={(event) => {
        // A pointer gesture supersedes a pending nudge burst — commit it first
        // so the gesture's member snapshot starts from the nudged position.
        flushNudge();
        // Not while editing: taking focus back would send the keystroke nowhere.
        if (!inlineText.editing) {
          focusDomEditOverlayElement(
            event.currentTarget as FocusableDomEditOverlay,
          );
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && cancelCanvasGesture()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (!inlineText.handleKeyDown(event)) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={handleOverlayPointerDown}
      onMouseDown={handleOverlayMouseDown}
      onPointerMove={marquee.onPointerMove}
      onPointerLeave={() => onCanvasPointerLeaveRef.current()}
      onPointerUp={marquee.onPointerUp}
      onPointerCancel={marquee.onPointerCancel}
      onLostPointerCapture={cancelCanvasGesture}
      onContextMenu={handleContextMenu}
    >
      {hoverSelection && hoverRect && compRect.width > 0 && (
        <div
          aria-hidden="true"
          data-dom-edit-hover-box="true"
          className="pointer-events-none absolute rounded-md border-2 border-studio-accent/80"
          style={{
            ...hoverRect,
            transform: hoverRect.angle
              ? `rotate(${hoverRect.angle}deg)`
              : undefined,
          }}
        />
      )}
      {hasGroupSelection &&
        groupOverlayItems.length > 1 &&
        groupBounds &&
        compRect.width > 0 && (
          <DomEditGroupChrome
            groupOverlayItems={groupOverlayItems}
            groupBounds={groupBounds}
            allowCanvasMovement={allowCanvasMovement}
            groupCanMove={groupCanMove}
            gestures={gestures}
            onBoxMouseDown={suppressBoxMouseDown}
            onBoxClick={handleBoxClick}
          />
        )}
      {!hasGroupSelection &&
        liveSelection &&
        selectionChromeRect &&
        compRect.width > 0 && (
          <DomEditSelectionChrome
            inlineText={inlineText}
            selection={liveSelection}
            overlayRect={selectionChromeRect}
            allowCanvasMovement={allowCanvasMovement}
            cropActive={cropActive}
            cropDisabled={cropDisabled}
            cropLinks={cropLinks}
            cropInsets={cropInsets}
            onCropInsetsPreview={onCropInsetsPreview}
            boxRef={boxRef}
            boxChromeClass={boxChromeClass}
            boxClipPath={boxClipPath}
            selectionKey={selectionKey}
            groupSelectionCount={groupSelections.length}
            blockedMoveRef={blockedMoveRef}
            gestures={gestures}
            onBoxMouseDown={suppressBoxMouseDown}
            onBoxClick={handleBoxClick}
          />
        )}
      <ChildRectOutlines rects={compRect.width > 0 ? childRects : []} />
      {/* Mounted here rather than with the selection chrome: the chrome does
          not render for every selection, and the toolbar belongs to the
          editing session, which does. */}
      {inlineText.toolbar}
      <MarqueeOverlay
        candidateRects={marquee.candidateRects}
        marqueeRect={marquee.marqueeRect}
      />
      {contextMenu && (
        <CanvasContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          selection={contextMenu.sel}
          onClose={closeContextMenu}
          onDelete={
            onDeleteSelection
              ? (sel) => {
                  closeContextMenu();
                  onDeleteSelection(sel);
                }
              : undefined
          }
          onApplyZIndex={
            onApplyZIndex
              ? (patches, action, crossed) => {
                  onApplyZIndex(contextMenu.sel, patches, action, crossed);
                }
              : undefined
          }
          onZOrderCrossed={handleZOrderCrossed}
        />
      )}
      <ZOrderCrossedFlash rect={zOrderFlashRect} />
      <GridOverlay
        visible={gridVisible}
        spacing={gridSpacing}
        scaleX={compRect.scaleX}
        scaleY={compRect.scaleY}
        compositionLeft={compRect.left}
        compositionTop={compRect.top}
        compositionWidth={compRect.width}
        compositionHeight={compRect.height}
      />
      <SnapGuideOverlay
        snapGuidesRef={snapGuidesRef}
        compositionLeft={compRect.left}
        compositionTop={compRect.top}
        compositionWidth={compRect.width}
        compositionHeight={compRect.height}
      />
    </div>
  );
});
