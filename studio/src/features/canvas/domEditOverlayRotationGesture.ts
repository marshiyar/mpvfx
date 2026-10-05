import { captureNativeGestureDraft } from "../project/nativeGestureDraft";
import { DomEditSaveQueueOpenError } from "../history/domEditSaveQueue";
import type { DomEditSelection } from "./domEditing";
import type { OverlayRect } from "./domEditOverlayGeometry";
import type { GestureState, UseDomEditOverlayGesturesOptions } from "./domEditOverlayGestures";
import { hasDomEditRotationChanged, resolveDomEditRotationGesture } from "./domEditOverlayGestures";
import { croppedRotationPivotTranslation } from "./domEditOverlayCrop";
import {
  applyManualOffsetDragCommit,
  applyManualOffsetDragDraft,
  applyRotationDraftViaGsap,
  endManualOffsetDragMembers,
  restoreManualOffsetDragMembers,
} from "./manualOffsetDrag";
import {
  applyStudioRotation,
  applyStudioRotationDraft,
  endStudioManualEditGesture,
  isStudioManualEditGestureCurrent,
  restoreStudioRotation,
} from "./manualEdits";

type RotationPointer = Pick<React.PointerEvent, "clientX" | "clientY" | "shiftKey">;

function pivotTranslation(g: GestureState, angle: number): { x: number; y: number } {
  return g.rotationVisibleOffset
    ? croppedRotationPivotTranslation(g.rotationVisibleOffset, g.actualRotation, angle)
    : { x: 0, y: 0 };
}

function paintRotationRect(
  g: GestureState,
  angle: number,
  setOverlayRect: (rect: OverlayRect) => void,
): { x: number; y: number } {
  const pivot = pivotTranslation(g, angle);
  setOverlayRect({
    left: g.originLeft + pivot.x,
    top: g.originTop + pivot.y,
    width: g.originWidth,
    height: g.originHeight,
    editScaleX: g.editScaleX,
    editScaleY: g.editScaleY,
    angle,
  });
  return pivot;
}

function rotationAt(g: GestureState, event: RotationPointer): { angle: number } {
  return resolveDomEditRotationGesture({
    centerX: g.centerX,
    centerY: g.centerY,
    startX: g.startX,
    startY: g.startY,
    currentX: event.clientX,
    currentY: event.clientY,
    actualAngle: g.actualRotation,
    snap: event.shiftKey,
  });
}

export function moveRotationGesture(
  g: GestureState,
  selection: DomEditSelection,
  event: RotationPointer,
  setOverlayRect: (rect: OverlayRect) => void,
): void {
  const rotated = rotationAt(g, event);
  g.lastRotation = rotated;
  if (!applyRotationDraftViaGsap(selection.element, rotated.angle)) {
    applyStudioRotationDraft(selection.element, rotated);
  }
  const pivot = pivotTranslation(g, rotated.angle);
  if (g.rotationVisibleOffset && g.pathOffsetMember) {
    applyManualOffsetDragDraft(g.pathOffsetMember, pivot.x, pivot.y);
  }
  paintRotationRect(g, rotated.angle, setOverlayRect);
  captureNativeGestureDraft(selection.element);
}

/** Keep angle, pivot translation, and released chrome in one gesture lifecycle. */
export function finishRotationGesture(
  g: GestureState,
  selection: DomEditSelection,
  event: RotationPointer,
  opts: UseDomEditOverlayGesturesOptions,
  setOverlayRect: (rect: OverlayRect) => void,
  restoreOverlayRect: () => void,
): void {
  const finalRotation = g.lastRotation ?? rotationAt(g, event);
  const restore = () => {
    if (!applyRotationDraftViaGsap(selection.element, g.actualRotation)) {
      restoreStudioRotation(selection.element, g.initialRotation);
    }
    if (g.pathOffsetMember) restoreManualOffsetDragMembers([g.pathOffsetMember]);
    restoreOverlayRect();
  };
  const end = () => {
    if (g.pathOffsetMember) endManualOffsetDragMembers([g.pathOffsetMember]);
    else endStudioManualEditGesture(selection.element, g.manualEditDragToken);
  };
  if (!hasDomEditRotationChanged(g.actualRotation, finalRotation.angle)) {
    restore();
    end();
    return;
  }

  if (!applyRotationDraftViaGsap(selection.element, finalRotation.angle)) {
    applyStudioRotation(selection.element, finalRotation);
  }
  const pivot = pivotTranslation(g, finalRotation.angle);
  const positionOffset = g.rotationVisibleOffset && g.pathOffsetMember
    ? applyManualOffsetDragCommit(g.pathOffsetMember, pivot.x, pivot.y)
    : undefined;
  paintRotationRect(g, finalRotation.angle, setOverlayRect);
  captureNativeGestureDraft(selection.element);
  void Promise.resolve(positionOffset
    ? opts.onRotationCommitRef.current(selection, finalRotation, positionOffset)
    : opts.onRotationCommitRef.current(selection, finalRotation))
    .catch((error) => {
      if (!(error instanceof DomEditSaveQueueOpenError)) console.error("rotate commit failed", error);
      if (g.manualEditDragToken &&
          isStudioManualEditGestureCurrent(selection.element, g.manualEditDragToken)) restore();
    })
    .finally(end);
}
