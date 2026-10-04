import { useRef } from "react";
import { usePlayerStore, type TimelineElement } from "../../player/index";
import { useEnableKeyframes, nativeToolbarPosition, type EnableKeyframesSession } from "../animation/Keyframe/useEnableKeyframes";
import type { NudgeSelectedKeyframesSession } from "../animation/Keyframe/nudgeSelectedKeyframes";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { DomEditSelection } from "../canvas/domEditingTypes";
import type { NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import type { NativeKeyframeProjectCommit } from "../../player/components/deleteSelectedKeyframes";

export interface DomEditSessionSlice extends EnableKeyframesSession {
  domEditSelection: DomEditSelection | null;
  selectedGsapAnimations: GsapAnimation[];
  handleGsapMoveKeyframes?: NudgeSelectedKeyframesSession["handleGsapMoveKeyframes"];
  nativeDocument?: NativeProjectDocument | null;
  commitNativeProject?: (
    commit: NativeKeyframeProjectCommit,
  ) => Promise<boolean>;
}

interface KeyframeToggleState {
  state: "active" | "inactive" | "none";
  isMotionPath: boolean;
  pathEndpoint: boolean;
  willExtend: boolean;
}

const NO_KEYFRAME_TOGGLE: KeyframeToggleState = {
  state: "none",
  isMotionPath: false,
  pathEndpoint: false,
  willExtend: false,
};

function resolveKeyframeToggleState(
  session: DomEditSessionSlice | undefined,
  currentTime: number,
): KeyframeToggleState {
  const native = nativeToolbarPosition(session, currentTime);
  if (!native) return NO_KEYFRAME_TOGGLE;
  return {
    state: native.active ? "active" : "inactive",
    isMotionPath: false,
    pathEndpoint: false,
    willExtend: false,
  };
}

/**
 * Can this element be keyframed at all?
 *
 * An audio clip cannot. It has no box on the canvas, so there is nothing to move,
 * scale or fade — and "add a keyframe" on one seeds a tween from the position
 * properties, which produced a position lane on a track that has no position. Audio
 * is automated instead: volume and effect parameters, on their own lanes.
 */
function isKeyframeable(element: TimelineElement | undefined): boolean {
  return element?.tag !== "audio";
}

export function useKeyframeToggle(session?: DomEditSessionSlice) {
  const currentTime = usePlayerStore((s) => s.currentTime);
  const selectedElementId = usePlayerStore((s) => s.selectedElementId);
  const elements = usePlayerStore((s) => s.elements);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const onToggle = useEnableKeyframes(
    sessionRef as React.RefObject<EnableKeyframesSession | undefined>,
  );

  const selected = elements.find(
    (element) => (element.key ?? element.id) === selectedElementId,
  );
  if (!isKeyframeable(selected))
    return { ...NO_KEYFRAME_TOGGLE, onToggle: undefined };

  const toggleState = resolveKeyframeToggleState(session, currentTime);

  return {
    ...toggleState,
    onToggle:
      session?.domEditSelection && toggleState.state !== "none"
        ? onToggle
        : undefined,
  };
}
