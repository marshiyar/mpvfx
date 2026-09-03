import { describe, expect, it } from "vitest";
import {
  timelineKeyframeSelectionKey,
  timelineKeyframeTargetFromSelectionKey,
} from "./timelineKeyframeIdentity";

describe("timeline keyframe selection identity", () => {
  it("round-trips an expanded lane with colon-bearing identities", () => {
    const key = timelineKeyframeSelectionKey("comp#a:child", {
      percentage: 75,
      tweenPercentage: 40,
      propertyGroup: "position",
      animationId: "child:position",
    });

    expect(timelineKeyframeTargetFromSelectionKey("comp#a:child", key)).toEqual({
      percentage: 75,
      tweenPercentage: 40,
      propertyGroup: "position",
      animationId: "child:position",
    });
  });

  it("does not confuse an expanded lane whose element id extends the active id", () => {
    const key = timelineKeyframeSelectionKey("comp#a:child", {
      percentage: 75,
      tweenPercentage: 40,
      propertyGroup: "position",
      animationId: "child-position",
    });

    expect(timelineKeyframeTargetFromSelectionKey("comp#a", key)).toBeNull();
  });

  // Timeline.tsx still writes the collapsed form for clip-lane shift-clicks, and
  // an element id can itself contain a colon — the split has to be the LAST one.
  it("splits the collapsed key at the last colon so a colon-bearing id survives", () => {
    expect(timelineKeyframeTargetFromSelectionKey("a:b", "a:b:40")).toEqual({ percentage: 40 });
    expect(timelineKeyframeTargetFromSelectionKey("a", "a:b:40")).toBeNull();
  });

  it("retains the collapsed key fallback and rejects malformed percentages", () => {
    expect(timelineKeyframeTargetFromSelectionKey("comp#a", "comp#a:30")).toEqual({
      percentage: 30,
    });
    expect(timelineKeyframeTargetFromSelectionKey("comp#a", "comp#a:NaN")).toBeNull();
    expect(timelineKeyframeTargetFromSelectionKey("comp#a", "comp#b:30")).toBeNull();
  });

  it("round-trips the complete native project address without confusing it for GSAP", () => {
    const target = {
      percentage: 37.5,
      tweenPercentage: 37.5,
      propertyGroup: "rotation",
      animationId: "native-parameter:rotation",
      native: {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:hero",
        parameterId: "transform.rotation",
        keyframeId: "keyframe:45",
        frame: 45,
        clipDurationFrames: 120,
        properties: { rotation: -180 },
        outgoing: {
          type: "cubic-bezier",
          controlPoints: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
        },
      },
    } as const;

    const key = timelineKeyframeSelectionKey("index.html#hero", target);

    expect(timelineKeyframeTargetFromSelectionKey("index.html#hero", key)).toEqual(target);
  });

  it("round-trips every scalar address represented by one grouped native diamond", () => {
    const nativeTargets = ["transform.position.x", "transform.position.y"].map(
      (parameterId, index) => ({
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:hero",
        parameterId,
        keyframeId: `keyframe:${index}`,
        frame: 45,
      }),
    );
    const target = {
      percentage: 37.5,
      tweenPercentage: 37.5,
      propertyGroup: "position",
      animationId: "native-parameter:position",
      native: nativeTargets[0]!,
      nativeTargets,
    } as const;

    const key = timelineKeyframeSelectionKey("index.html#hero", target);

    expect(timelineKeyframeTargetFromSelectionKey("index.html#hero", key)).toEqual(target);
  });

  it("rejects malformed native property data and interpolation metadata", () => {
    const base = [
      "hero",
      "rotation",
      "native-parameter:rotation",
      50,
      50,
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:hero",
        parameterId: "transform.rotation",
        keyframeId: "keyframe:60",
        frame: 60,
        properties: { rotation: Number.NaN },
        outgoing: { type: "spring" },
      },
    ];

    expect(timelineKeyframeTargetFromSelectionKey("hero", JSON.stringify(base))).toBeNull();
  });

  it("keeps distinct native keyframes distinct even when their rendered percentages collide", () => {
    const shared = {
      percentage: 50,
      tweenPercentage: 50,
      propertyGroup: "position",
      animationId: "native-parameter:position",
      native: {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:hero",
        parameterId: "transform.position.x",
        frame: 60,
      },
    } as const;

    const first = timelineKeyframeSelectionKey("hero", {
      ...shared,
      native: { ...shared.native, keyframeId: "keyframe:x" },
    });
    const second = timelineKeyframeSelectionKey("hero", {
      ...shared,
      native: { ...shared.native, keyframeId: "keyframe:y" },
    });

    expect(first).not.toBe(second);
  });

  it("rejects malformed native addresses instead of returning a partial command target", () => {
    const malformed = JSON.stringify([
      "hero",
      "rotation",
      "native-parameter:rotation",
      50,
      50,
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:hero",
        parameterId: "transform.rotation",
        keyframeId: "keyframe:60",
        frame: 60.5,
      },
    ]);

    expect(timelineKeyframeTargetFromSelectionKey("hero", malformed)).toBeNull();
  });
});
