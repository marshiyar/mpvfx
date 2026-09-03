import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import { usePlayerStore } from "../player/store/playerStore";

function selectionElementKey(selection: DomEditSelection): string {
  return `${selection.sourceFile || "index.html"}#${selection.id}`;
}

/**
 * Resolve the selected keyframe only when it belongs to the exact source tween
 * an editing gesture is about to mutate. A bare percentage is never command
 * identity: two property groups (or two overlapping tweens) can both own 50%.
 */
export function activeKeyframePercentageForAnimation(
  selection: DomEditSelection,
  animation: Pick<GsapAnimation, "id">,
): number | null {
  const target = usePlayerStore.getState().activeKeyframeTarget;
  if (!target || target.elementId !== selectionElementKey(selection)) return null;
  if (target.animationId === animation.id) return target.tweenPercentage;
  return (
    target.collidingAnimationTargets?.find((candidate) => candidate.animationId === animation.id)
      ?.tweenPercentage ?? null
  );
}

/** A canvas edit consumes the one-shot active-key target, whether or not it matched. */
export function clearActiveKeyframeTarget(): void {
  usePlayerStore.getState().setActiveKeyframeTarget(null);
}
