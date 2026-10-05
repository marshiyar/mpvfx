import { useCallback } from "react";
import type { DomEditSelection } from "../../canvas/domEditingTypes";
import { readCropCenterOffsetFraction } from "../../canvas/domEditOverlayCrop";
import { runGestureTransaction } from "../../canvas/gestureTransaction";
import { computeDraggedGsapPosition } from "./draggedGsapPosition";
import { tryGsapDragIntercept, tryGsapRotationIntercept } from "./gsapRuntimeBridge";
import { assertGsapEditPersisted } from "./gsapEditOutcome";
import type { UseGsapAwareEditingParams } from "./gsapAwareEditingContract";

type NativeCommit = ReturnType<typeof import("../useProjectAnimatedPropertyCommit").useProjectAnimatedPropertyCommit>;
type RotationDependencies = Pick<UseGsapAwareEditingParams,
  "selectedGsapAnimations" | "gsapCommitMutation" | "previewIframeRef" |
  "makeFetchFallback" | "trackGsapInteractionFailure"> & {
    projectPropertyCommit: NativeCommit;
  };

/** Persist crop pivot position and angle under one native or source transaction. */
export function useGsapAwareRotationCommit({
  selectedGsapAnimations,
  gsapCommitMutation,
  previewIframeRef,
  makeFetchFallback,
  trackGsapInteractionFailure,
  projectPropertyCommit,
}: RotationDependencies) {
  return useCallback(async (
    selection: DomEditSelection,
    next: { angle: number },
    offset?: { x: number; y: number },
  ) => {
    if (projectPropertyCommit.isNativeSelection(selection)) {
      try {
        const position = offset
          ? computeDraggedGsapPosition(selection.element, offset, { x: 0, y: 0 })
          : null;
        const cropPivotFraction = position ? readCropCenterOffsetFraction(selection.element) : null;
        await projectPropertyCommit.commitAnimatedProperties(
          selection,
          { rotation: next.angle, ...(position ? { x: position.newX, y: position.newY } : {}) },
          { intent: "edit", ...(cropPivotFraction ? { cropPivotFraction } : {}) },
        );
        return;
      } catch (error) {
        trackGsapInteractionFailure(error, selection, "rotation", "Rotate animated layer");
        throw error;
      }
    }
    if (offset) {
      if (!gsapCommitMutation?.batch) {
        throw new Error("Cropped rotation requires an atomic position and rotation save");
      }
      try {
        await runGestureTransaction({
          element: selection.element,
          label: "Rotate cropped layer",
          settle: () => undefined,
          restore: () => undefined,
          persist: async (commit) => {
            const queuedCommit = commit(gsapCommitMutation);
            const rotationOutcome = await tryGsapRotationIntercept(
              selection, next.angle, selectedGsapAnimations, previewIframeRef.current,
              queuedCommit, makeFetchFallback(selection),
            );
            assertGsapEditPersisted(rotationOutcome);
            const positionOutcome = await tryGsapDragIntercept(
              selection, offset, selectedGsapAnimations, previewIframeRef.current,
              queuedCommit, makeFetchFallback(selection),
            );
            assertGsapEditPersisted(positionOutcome);
          },
        });
        return;
      } catch (error) {
        trackGsapInteractionFailure(error, selection, "rotation", "Rotate cropped layer");
        throw error;
      }
    }
    if (gsapCommitMutation) {
      try {
        const outcome = await tryGsapRotationIntercept(
          selection, next.angle, selectedGsapAnimations, previewIframeRef.current,
          gsapCommitMutation, makeFetchFallback(selection),
        );
        assertGsapEditPersisted(outcome);
      } catch (error) {
        trackGsapInteractionFailure(error, selection, "rotation", "Rotate animated layer");
        throw error;
      }
    }
  }, [
    selectedGsapAnimations, gsapCommitMutation, previewIframeRef,
    makeFetchFallback, trackGsapInteractionFailure, projectPropertyCommit,
  ]);
}
