import type { RefObject } from "react";
import { type DomEditSelection } from "./domEditing";
import type { GroupOverlayItem, OverlayRect } from "./domEditOverlayGeometry";
import type { BlockedMoveState, ResizeHandle } from "./domEditOverlayGestures";
import type { createDomEditOverlayGestureHandlers } from "./useDomEditOverlayGestures";
import { DomEditCropHandles } from "./DomEditCropHandles";
import { DomEditRotateHandle } from "./DomEditRotateHandle";
import { resolveRotatedResizeCursor } from "./domEditResizeLocal";
import type { CropLinkState } from "./domEditOverlayCrop";
import type { ClipPathInsetSides } from "./clipPathHelpers";

// Corner resize handles, Canva-style: one per corner, diagonal cursors.
// Corners scale about the element center; the translate keeps the center
// planted, so they need the manual-offset capability in addition to manual-size.
const RESIZE_HANDLE_DEFS: Array<{
  handle: ResizeHandle;
  cursor: string;
  x: "left" | "right";
  y: "top" | "bottom";
}> = [
  { handle: "nw", cursor: "nwse-resize", x: "left", y: "top" },
  { handle: "ne", cursor: "nesw-resize", x: "right", y: "top" },
  { handle: "sw", cursor: "nesw-resize", x: "left", y: "bottom" },
  { handle: "se", cursor: "nwse-resize", x: "right", y: "bottom" },
];

// Visible dot is 9px; the pointer target is a 16px invisible square centered
// on the corner so click targets don't shrink with the smaller dot.
const RESIZE_HANDLE_HIT_PX = 16;

function resizeHandleStyle(
  def: (typeof RESIZE_HANDLE_DEFS)[number],
  overlayRect: { left: number; top: number; width: number; height: number },
): React.CSSProperties {
  const half = RESIZE_HANDLE_HIT_PX / 2;
  const style: React.CSSProperties = {
    cursor: def.cursor,
    touchAction: "none",
  };
  // Position relative to the overlay container (not the selection box).
  // This ensures the dots render as siblings of the box border div — strictly
  // above it — rather than as children where the parent border can visually
  // overlap the dot circle at the corner.
  style.left =
    def.x === "left"
      ? overlayRect.left - half
      : overlayRect.left + overlayRect.width - half;
  style.top =
    def.y === "top"
      ? overlayRect.top - half
      : overlayRect.top + overlayRect.height - half;
  return style;
}

type GestureHandlers = ReturnType<typeof createDomEditOverlayGestureHandlers>;

interface DomEditGroupChromeProps {
  groupOverlayItems: GroupOverlayItem[];
  groupBounds: OverlayRect;
  allowCanvasMovement: boolean;
  groupCanMove: boolean;
  gestures: GestureHandlers;
  onBoxMouseDown: (e: React.MouseEvent) => void;
  onBoxClick: (event: React.MouseEvent<HTMLDivElement>) => void;
}

// Multi-selection chrome: per-member outlines plus a single draggable bounding
// box spanning the union of the members.
export function DomEditGroupChrome({
  groupOverlayItems,
  groupBounds,
  allowCanvasMovement,
  groupCanMove,
  gestures,
  onBoxMouseDown,
  onBoxClick,
}: DomEditGroupChromeProps) {
  return (
    <>
      {groupOverlayItems.map((item) => (
        <div
          key={item.key}
          aria-hidden="true"
          className="pointer-events-none absolute rounded-xl border border-studio-accent/70"
          style={{
            left: item.rect.left,
            top: item.rect.top,
            width: item.rect.width,
            height: item.rect.height,
          }}
        />
      ))}
      <div
        data-dom-edit-selection-box="true"
        className="pointer-events-auto absolute rounded-xl border-2 border-studio-accent"
        style={{
          left: groupBounds.left,
          top: groupBounds.top,
          width: groupBounds.width,
          height: groupBounds.height,
          cursor: allowCanvasMovement && groupCanMove ? "move" : "default",
        }}
        onPointerDown={(e) => {
          if (!allowCanvasMovement || !groupCanMove || e.shiftKey) return;
          gestures.startGroupDrag(e);
        }}
        onMouseDown={onBoxMouseDown}
        onClick={onBoxClick}
      />
    </>
  );
}

interface DomEditSelectionChromeProps {
  selection: DomEditSelection;
  overlayRect: OverlayRect;
  allowCanvasMovement: boolean;
  cropActive?: boolean;
  cropDisabled?: boolean;
  cropLinks?: CropLinkState;
  cropInsets?: ClipPathInsetSides;
  onCropInsetsPreview?: (insets: ClipPathInsetSides) => void;
  boxRef: RefObject<HTMLDivElement | null>;
  boxChromeClass: string;
  boxClipPath: string | undefined;
  selectionKey: string;
  groupSelectionCount: number;
  blockedMoveRef: RefObject<BlockedMoveState | null>;
  gestures: GestureHandlers;
  onBoxMouseDown: (e: React.MouseEvent) => void;
  onBoxClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  /** The canvas' text-editing session: what opens one, and whether one is open. */
  inlineText?: {
    editing: boolean;
    /** Every press on the box. Returns true when it opened a text edit. */
    startFromPress: (event: React.PointerEvent) => boolean;
  };
}

// Oriented selection chrome: a rotation wrapper spanning the overlay, rotated by
// the element's live angle about the selection box CENTER. Its children (border
// box, corner dots, and rotate handle) keep their existing
// overlay-absolute positions — rotating the whole plane about the box center
// lands them on the element's real transformed corners for free. At angle 0 the
// transform is a no-op, so the chrome is pixel-identical.
export function DomEditSelectionChrome({
  selection,
  overlayRect,
  allowCanvasMovement,
  cropActive = false,
  cropDisabled = false,
  cropLinks,
  cropInsets,
  onCropInsetsPreview,
  boxRef,
  boxChromeClass,
  boxClipPath,
  selectionKey,
  groupSelectionCount,
  blockedMoveRef,
  gestures,
  onBoxMouseDown,
  onBoxClick,
  inlineText,
}: DomEditSelectionChromeProps) {
  // While the text is being edited the chrome is a mark, not a control. The
  // overlay above the preview already stands aside for the caret, but
  // `pointer-events: none` on a parent does not disable a child that asks for
  // them back, and the box is positioned to cover exactly the text being typed
  // into: left interactive, it swallows every press, so the caret can never be
  // moved and characters can never be selected by dragging.
  const editing = inlineText?.editing ?? false;

  return (
    <>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          transformOrigin: `${overlayRect.left + overlayRect.width / 2}px ${overlayRect.top + overlayRect.height / 2}px`,
          transform: overlayRect.angle
            ? `rotate(${overlayRect.angle}deg)`
            : undefined,
        }}
      >
        {!cropActive &&
          allowCanvasMovement &&
          !editing &&
          selection.capabilities.canApplyManualRotation && (
            <DomEditRotateHandle
              overlayRect={overlayRect}
              onStartRotate={(e) => {
                e.stopPropagation();
                gestures.startGesture("rotate", e, {
                  interactionRect: overlayRect,
                });
              }}
            />
          )}
        {!cropActive && (
          <div
            key={selectionKey}
            ref={boxRef}
            data-dom-edit-selection-box="true"
            className={`${editing ? "pointer-events-none" : "pointer-events-auto"} absolute rounded-md ${boxChromeClass}`}
            style={{
              left: overlayRect.left,
              top: overlayRect.top,
              width: overlayRect.width,
              height: overlayRect.height,
              clipPath: boxClipPath,
              cursor:
                allowCanvasMovement &&
                selection.capabilities.canApplyManualOffset
                  ? "move"
                  : "default",
            }}
            onPointerDown={(e) => {
              // A second press opens the element's text for editing, and must be
              // caught here rather than on the canvas: this handler prevents the
              // default on the first press, which suppresses the compatibility
              // mousedown the canvas would otherwise see, and the pointer capture
              // it takes stops the browser pairing the presses into a dblclick.
              if (inlineText?.startFromPress(e)) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              if (!allowCanvasMovement || e.shiftKey) return;
              if (selection.capabilities.canApplyManualOffset) {
                gestures.startGesture("drag", e);
                return;
              }
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              blockedMoveRef.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                notified: false,
              };
            }}
            onMouseDown={onBoxMouseDown}
            onClick={onBoxClick}
          />
        )}
        {/* Resize-handle dots rendered as siblings of the selection box, not
          children, so they paint strictly above the box border. Each handle
          is positioned relative to the overlay container using the
          overlayRect origin, matching the old child-relative offsets. */}
        {allowCanvasMovement &&
          !cropActive &&
          !editing &&
          selection.capabilities.canApplyManualSize &&
          RESIZE_HANDLE_DEFS.map((def) =>
            def.handle !== "se" &&
            !selection.capabilities.canApplyManualOffset ? null : (
              <div
                key={def.handle}
                className="pointer-events-auto absolute flex h-4 w-4 items-center justify-center"
                style={{
                  ...resizeHandleStyle(def, overlayRect),
                  // Cursor rotates with the object: bucket the corner's base
                  // diagonal + element rotation into the 8 CSS resize cursors.
                  cursor: resolveRotatedResizeCursor(
                    def.handle,
                    overlayRect.angle ?? 0,
                  ),
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  gestures.startGesture("resize", e, {
                    interactionRect: overlayRect,
                    resizeHandle: def.handle,
                  });
                }}
              >
                <div className="pointer-events-none h-[12px] w-[12px] rounded-full border-[1.5px] border-studio-accent bg-white" />
              </div>
            ),
          )}
      </div>
      {/* Crop owns its element-local oriented frame. Keep it outside the chrome's
          rotated plane or a rotated selection applies the angle twice. */}
      {cropActive &&
        selection.capabilities.canCrop &&
        !editing &&
        groupSelectionCount <= 1 && (
          <DomEditCropHandles
            selection={selection}
            overlayRect={overlayRect}
            links={cropLinks}
            sessionInsets={cropInsets}
            disabled={cropDisabled}
            onSessionInsetsChange={onCropInsetsPreview}
          />
        )}
    </>
  );
}
