import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import { usePlayerStore } from "../player/store/playerStore";
import { resolveTweenStart } from "../utils/globalTimeCompiler";
import { activeKeyframePercentageForAnimation } from "./activeKeyframeIdentity";
import { keyframeIsAtOutputTime, resolveEditableTweenDuration } from "./gsapShared";

/** A selected diamond owns the edit even while its seek is still in flight.
 * Otherwise resolve the rendered output frame to its exact authored key. */
export function gsapKeyframeEditTarget(
  selection: DomEditSelection,
  animation: GsapAnimation,
  currentTime = usePlayerStore.getState().currentTime,
): number | null {
  const selected = activeKeyframePercentageForAnimation(selection, animation);
  if (selected != null) return selected;
  const start =
    resolveTweenStart(animation) ??
    (Number.parseFloat(selection.dataAttributes?.start ?? "0") || 0);
  const duration = resolveEditableTweenDuration(animation, selection);
  return (
    animation.keyframes?.keyframes.find((keyframe) =>
      keyframeIsAtOutputTime(keyframe.percentage, currentTime, { start, duration }),
    )?.percentage ?? null
  );
}
