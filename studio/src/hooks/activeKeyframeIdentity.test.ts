// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import { usePlayerStore } from "../player/store/playerStore";
import { activeKeyframePercentageForAnimation } from "./activeKeyframeIdentity";

const selection = {
  id: "hero",
  sourceFile: "scene.html",
} as DomEditSelection;

const animation = (id: string) => ({ id }) as GsapAnimation;

describe("activeKeyframePercentageForAnimation", () => {
  beforeEach(() => usePlayerStore.getState().setActiveKeyframeTarget(null));

  it("returns a percentage only for the exact source element and animation", () => {
    usePlayerStore.getState().setActiveKeyframeTarget({
      elementId: "scene.html#hero",
      animationId: "opacity-tween",
      propertyGroup: "visual",
      tweenPercentage: 75,
    });

    expect(activeKeyframePercentageForAnimation(selection, animation("opacity-tween"))).toBe(75);
    expect(activeKeyframePercentageForAnimation(selection, animation("position-tween"))).toBeNull();
    expect(
      activeKeyframePercentageForAnimation(
        { ...selection, sourceFile: "other.html" },
        animation("opacity-tween"),
      ),
    ).toBeNull();
  });

  it("uses the matching source percentage from a colliding merged diamond", () => {
    usePlayerStore.getState().setActiveKeyframeTarget({
      elementId: "scene.html#hero",
      animationId: "position-tween",
      propertyGroup: "position",
      tweenPercentage: 100,
      collidingAnimationTargets: [
        { animationId: "position-tween", tweenPercentage: 100 },
        { animationId: "scale-tween", tweenPercentage: 62.5 },
      ],
    });

    expect(activeKeyframePercentageForAnimation(selection, animation("scale-tween"))).toBe(62.5);
  });
});
