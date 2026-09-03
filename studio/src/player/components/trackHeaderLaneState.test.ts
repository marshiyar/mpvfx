import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import { describe, expect, it } from "vitest";
import { getTimelinePropertyLanes } from "./TimelinePropertyLanes";
import { resolveLaneHeaderState } from "./trackHeaderLaneState";

describe("resolveLaneHeaderState frame identity", () => {
  it("treats sub-frame seek rounding as the current keyframe on a long clip", () => {
    const animation = {
      id: "position",
      targetSelector: "#clip",
      method: "to",
      position: 0,
      resolvedStart: 0,
      duration: 100,
      propertyGroup: "position",
      properties: {},
      keyframes: {
        format: "percentage",
        keyframes: [
          { percentage: 0, properties: { x: 0 } },
          { percentage: 50, properties: { x: 50 } },
          { percentage: 100, properties: { x: 100 } },
        ],
      },
    } as GsapAnimation;
    const lane = getTimelinePropertyLanes([animation], 0, 100)[0]!;
    const currentTime = 50 + 1 / 90;
    const clipPercentage = (currentTime / 100) * 100;

    const state = resolveLaneHeaderState(lane, currentTime, clipPercentage, 100);

    expect(state.navigation.currentKeyframe?.percentage).toBe(50);
    expect(state.toggleTarget?.remove).toBe(true);
  });
});
