import { useCallback } from "react";
import type { NativeProjectDocument } from "../../../../shared/project/nativeProjectDocument";
import { projectNativeKeyframeUi } from "../../../../shared/project/nativeKeyframeUiProjection";
import type { NativeProjectKeyframeTarget } from "./useNativeProjectKeyframeCommands";
import type { DomEditSelection } from "../../canvas/domEditingTypes";
import { usePlayerStore } from "../../../player/store/playerStore";

export interface EnableKeyframesSession {
  nativeProjectDocument?: NativeProjectDocument | null;
  domEditSelection: DomEditSelection | null;
  commitKeyframeProperties?: (
    selection: DomEditSelection,
    properties: Record<string, number | string>,
  ) => Promise<void>;
  deleteNativeKeyframes?: (targets: readonly NativeProjectKeyframeTarget[]) => Promise<void>;
}

/** Shared by the toolbar indicator and its command; never consult legacy tweens
 * for a clip whose position is edited by the native project. */
export function nativeToolbarPosition(
  session: EnableKeyframesSession | undefined,
  time: number,
) {
  const selection = session?.domEditSelection;
  if (!session?.nativeProjectDocument || !selection) return null;
  const result = projectNativeKeyframeUi(session.nativeProjectDocument, {
    selectedElement: {
      id: selection.id,
      hfId: selection.hfId,
      sourceFile: selection.sourceFile,
      selector: selection.selector,
      selectorIndex: selection.selectorIndex,
      attributes: {
        "data-studio-clip-id": selection.element.getAttribute(
          "data-studio-clip-id",
        ),
      },
    },
    playheadSeconds: time,
  });
  if (!result.ok) return null;
  const keys = result.keyframeRows.filter(
    (row) =>
      ("x" in row.properties || "y" in row.properties) &&
      row.nativeFrame === result.clipLocalFrame,
  );
  return {
    projection: result,
    active:
      keys.some((row) => "x" in row.properties) &&
      keys.some((row) => "y" in row.properties),
    targets: keys.map((row) => ({
      sequenceId: result.sequenceId,
      trackId: result.trackId,
      clipId: result.clipId,
      parameterId: row.parameterId,
      frame: row.nativeFrame,
    })),
  };
}

/** The toolbar authors the same position tracks as the inspector. */
export function useEnableKeyframes(
  sessionRef: React.RefObject<EnableKeyframesSession | undefined>,
) {
  return useCallback(async () => {
    const session = sessionRef.current;
    const selection = session?.domEditSelection;
    if (!session || !selection) return;
    const native = nativeToolbarPosition(session, usePlayerStore.getState().currentTime);
    if (!native) throw new Error("This layer is not available for native position keyframing");
    if (native.active) {
      if (!session.deleteNativeKeyframes) throw new Error("Position keyframe removal is unavailable");
      await session.deleteNativeKeyframes(native.targets);
    } else {
      if (!session.commitKeyframeProperties) throw new Error("Position keyframe saving is unavailable");
      await session.commitKeyframeProperties(selection, {
        x: native.projection.currentValues.x ?? 0,
        y: native.projection.currentValues.y ?? 0,
      });
    }
  }, [sessionRef]);
}
