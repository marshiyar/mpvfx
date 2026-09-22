import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import { usePlayerStore } from "../player/store/playerStore";
import { resolveTweenStart } from "../utils/globalTimeCompiler";
import { gsapKeyframeEditTarget } from "./gsapKeyframeEditTarget";
import {
  computeElementPercentage,
  resolveEditableTweenDuration,
  writeTargetSelector,
} from "./gsapShared";
import { GsapEditBlockedError } from "./gsapEditOutcome";

/** Add a property's channel to an existing clip animation. Every other authored
 * pose keeps its pre-edit value, including when the first edit is at key A. */
export function newPropertyKeyframes(
  selection: DomEditSelection,
  template: GsapAnimation,
  properties: Record<string, number | string>,
  baseline: Record<string, number | string>,
) {
  const targetSelector = writeTargetSelector(selection);
  if (!targetSelector) throw new GsapEditBlockedError("no-selector");
  const percentage =
    gsapKeyframeEditTarget(selection, template) ??
    computeElementPercentage(usePlayerStore.getState().currentTime, selection, template);
  const percentages = new Set([
    0,
    ...(template.keyframes?.keyframes.map((key) => key.percentage) ?? [100]),
    percentage,
  ]);
  return {
    type: "add-with-keyframes",
    targetSelector,
    position: resolveTweenStart(template) ?? 0,
    duration: resolveEditableTweenDuration(template, selection),
    keyframes: [...percentages]
      .sort((a, b) => a - b)
      .map((key) => ({
        percentage: key,
        properties: { ...(key === percentage ? properties : baseline) },
      })),
    ...(template.ease ? { ease: template.ease } : {}),
    ...(template.keyframes?.easeEach ? { easeEach: template.keyframes.easeEach } : {}),
  };
}
