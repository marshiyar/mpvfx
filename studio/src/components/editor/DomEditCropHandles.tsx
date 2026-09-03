import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { DomEditSelection } from "./domEditing";
import type { OverlayRect } from "./domEditOverlayGeometry";
import {
  type CropEdge,
  type CropLinkState,
  cropRectFromInsets,
  readElementCropFrame,
  readElementCropInsets,
  resolveCropInsetFromEdgeDrag,
  rotateDeltaIntoFrame,
} from "./domEditOverlayCrop";
import { buildInsetClipPathSides, type ClipPathInsetSides } from "./clipPathHelpers";

interface CropGestureState {
  edge: CropEdge;
  pointerId: number;
  startX: number;
  startY: number;
  startInsets: ClipPathInsetSides;
  currentInsets: ClipPathInsetSides;
  didMove: boolean;
  /** Element frame captured at gesture start: pointer deltas rotate into it. */
  angleDeg: number;
  scaleX: number;
  scaleY: number;
}

interface DomEditCropHandlesProps {
  selection: DomEditSelection;
  overlayRect: OverlayRect;
  links?: CropLinkState;
  sessionInsets?: ClipPathInsetSides;
  disabled?: boolean;
  onSessionInsetsChange?: (insets: ClipPathInsetSides) => void;
}

const EDGE_HIT_THICKNESS = 12;
const CROP_LINE_EXTENSION = 12;

const EDGES: CropEdge[] = ["top", "right", "bottom", "left"];

/**
 * Explicit crop-mode chrome. Four square, solid lines mark the crop edges and
 * extend beyond the media frame. The frame has no overlay fill. Dragging a line
 * changes only the live session draft; Apply owns the one durable source write.
 */
export function DomEditCropHandles({
  selection,
  overlayRect,
  links = { all: false, vertical: false, horizontal: false },
  sessionInsets,
  disabled = false,
  onSessionInsetsChange,
}: DomEditCropHandlesProps) {
  const gestureRef = useRef<CropGestureState | null>(null);
  // readElementCropInsets returns null for a clip this tool can't represent
  // (circle/polygon/non-px inset): the crop UI must fully stand down for that
  // element — no lift, no handles — or select+deselect replaces the authored
  // clip with an inset (or deletes it).
  const cropStateFor = (element: HTMLElement) => {
    const parsed = readElementCropInsets(element);
    const insets = parsed
      ? { top: parsed.top, right: parsed.right, bottom: parsed.bottom, left: parsed.left }
      : { top: 0, right: 0, bottom: 0, left: 0 };
    return { element, croppable: parsed !== null, insets };
  };
  const [state, setState] = useState(() => cropStateFor(selection.element));

  // Re-sync when the selection targets a different element (reselect, or an
  // undo/redo that re-keys the node): read its committed crop before the lift
  // effect runs. Read inside the guard so a drag's per-frame setState doesn't
  // re-run getComputedStyle every frame.
  if (state.element !== selection.element) {
    setState(cropStateFor(selection.element));
  }

  // The crop applies in the element's LOCAL frame (clip-path precedes the
  // transform), so all crop UI is drawn inside a container rotated with the
  // element — on a rotated element an axis-aligned dim visually "straightens"
  // it by masking the rotated corners.
  const frame = readElementCropFrame(selection.element, overlayRect);
  const width = frame.width / frame.scaleX; // element CSS px
  const height = frame.height / frame.scaleY;
  const displayedInsets = gestureRef.current?.currentInsets ?? sessionInsets ?? state.insets;
  // Crop rect in FRAME-LOCAL coordinates (origin = frame top-left).
  const cropRect = cropRectFromInsets(
    { left: 0, top: 0, width: frame.width, height: frame.height },
    displayedInsets,
    frame.scaleX,
    frame.scaleY,
  );

  const showDraft = (nextInsets: ClipPathInsetSides) => {
    const cropped = Object.values(nextInsets).some((value) => value > 0);
    selection.element.style.setProperty(
      "clip-path",
      cropped ? buildInsetClipPathSides(nextInsets, 0) : "none",
    );
    setState((prev) => ({ ...prev, insets: nextInsets }));
    onSessionInsetsChange?.(nextInsets);
  };

  const startCropGesture = (edge: CropEdge, event: ReactPointerEvent<HTMLElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startInsets: displayedInsets,
      currentInsets: displayedInsets,
      didMove: false,
      angleDeg: frame.angleDeg,
      scaleX: frame.scaleX,
      scaleY: frame.scaleY,
    };
  };

  const updateCropGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const local = rotateDeltaIntoFrame(
      event.clientX - gesture.startX,
      event.clientY - gesture.startY,
      gesture.angleDeg,
    );
    const drag = {
      startInsets: gesture.startInsets,
      deltaX: local.deltaX,
      deltaY: local.deltaY,
      scaleX: gesture.scaleX,
      scaleY: gesture.scaleY,
    };
    const nextInsets = resolveCropInsetFromEdgeDrag({
      ...drag,
      edge: gesture.edge,
      width,
      height,
      links,
    });
    gesture.didMove = true;
    gesture.currentInsets = nextInsets;
    showDraft(nextInsets);
  };

  const finishCropGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    gestureRef.current = null;
    if (!gesture.didMove) return;
    showDraft(gesture.currentInsets);
  };

  const cancelCropGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    gestureRef.current = null;
    showDraft(gesture.startInsets);
  };

  // Uneditable clip (circle/polygon/non-px inset): the element renders exactly
  // as authored and the crop tool shows nothing. All hooks above stay mounted.
  if (!state.croppable) return null;

  return (
    <div
      data-dom-edit-crop-frame="true"
      className="pointer-events-none absolute"
      style={{
        left: frame.left,
        top: frame.top,
        width: frame.width,
        height: frame.height,
        transform: frame.angleDeg !== 0 ? `rotate(${frame.angleDeg}deg)` : undefined,
      }}
    >
      {EDGES.map((edge) => {
        const vertical = edge === "left" || edge === "right";
        const boundary =
          edge === "top"
            ? cropRect.top
            : edge === "bottom"
              ? cropRect.top + cropRect.height
              : edge === "left"
                ? cropRect.left
                : cropRect.left + cropRect.width;
        const lineStyle: React.CSSProperties = vertical
          ? {
              left: boundary,
              top: -CROP_LINE_EXTENSION,
              width: 1,
              height: frame.height + CROP_LINE_EXTENSION * 2,
            }
          : {
              left: -CROP_LINE_EXTENSION,
              top: boundary,
              width: frame.width + CROP_LINE_EXTENSION * 2,
              height: 1,
            };
        const hitStyle: React.CSSProperties = vertical
          ? {
              left: boundary - EDGE_HIT_THICKNESS / 2,
              top: -CROP_LINE_EXTENSION,
              width: EDGE_HIT_THICKNESS,
              height: frame.height + CROP_LINE_EXTENSION * 2,
            }
          : {
              left: -CROP_LINE_EXTENSION,
              top: boundary - EDGE_HIT_THICKNESS / 2,
              width: frame.width + CROP_LINE_EXTENSION * 2,
              height: EDGE_HIT_THICKNESS,
            };
        return (
          <div key={edge}>
            <div
              aria-hidden="true"
              data-dom-edit-crop-line={edge}
              className="pointer-events-none absolute bg-studio-accent"
              style={lineStyle}
            />
            <button
              type="button"
              aria-label={`Crop ${edge}`}
              title={`Crop ${edge}`}
              data-dom-edit-crop-handle={edge}
              disabled={disabled}
              className="pointer-events-auto absolute border-0 bg-transparent p-0 disabled:pointer-events-none"
              style={{
                ...hitStyle,
                cursor: vertical ? "ew-resize" : "ns-resize",
                touchAction: "none",
              }}
              onPointerDown={(event) => startCropGesture(edge, event)}
              onPointerMove={updateCropGesture}
              onPointerUp={finishCropGesture}
              onPointerCancel={cancelCropGesture}
            />
          </div>
        );
      })}
    </div>
  );
}
