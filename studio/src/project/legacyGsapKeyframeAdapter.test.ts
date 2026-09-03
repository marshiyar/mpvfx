import { describe, expect, it } from "vitest";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";

import { evaluateNativeParameterTrack } from "./nativeKeyframeEvaluator";
import { adaptLegacyGsapAnimations } from "./legacyGsapKeyframeAdapter";

const fps = { numerator: 30, denominator: 1 };

function animation(overrides: Partial<GsapAnimation>): GsapAnimation {
  return {
    id: "legacy:rotation",
    targetSelector: "#not-a-native-id",
    method: "fromTo",
    position: 0,
    resolvedStart: 0,
    duration: 3,
    properties: { rotation: -180 },
    fromProperties: { rotation: 0 },
    ...overrides,
  };
}

describe("legacy GSAP keyframe adapter", () => {
  it("imports an explicit 0→-180 rotation as a frame-accurate native parameter track", () => {
    const result = adaptLegacyGsapAnimations({
      clipId: "clip:camera-a",
      clipStartSeconds: 0,
      frameRate: fps,
      animations: [animation({})],
    });

    expect(result.legacyOnly).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.nativeTracks).toHaveLength(1);
    const rotation = result.nativeTracks[0]!;
    expect(rotation).toMatchObject({
      parameterId: "transform.rotation",
      valueType: "number",
      keyframes: [
        { frame: 0, value: 0, outgoing: { type: "linear" } },
        { frame: 90, value: -180 },
      ],
    });
    expect(rotation.id).toContain("clip:camera-a");
    expect(rotation.id).not.toContain("#not-a-native-id");
    expect(evaluateNativeParameterTrack(rotation, 45)).toBe(-90);
  });

  it("converts resolved seconds and percentage keyframes into integer clip-local frames", () => {
    const result = adaptLegacyGsapAnimations({
      clipId: "clip:camera-a",
      clipStartSeconds: 2,
      frameRate: fps,
      animations: [
        animation({
          id: "legacy:position",
          method: "to",
          resolvedStart: 2,
          duration: 2,
          properties: {},
          fromProperties: undefined,
          keyframes: {
            format: "percentage",
            keyframes: [
              { percentage: 0, properties: { x: 10, y: 20 }, ease: "none" },
              { percentage: 50, properties: { x: 70, y: 80 }, ease: "linear" },
              { percentage: 100, properties: { x: 100, y: 120 } },
            ],
          },
        }),
      ],
    });

    expect(result.legacyOnly).toEqual([]);
    expect(result.nativeTracks.map((track) => track.parameterId)).toEqual([
      "transform.position.x",
      "transform.position.y",
    ]);
    expect(result.nativeTracks[0]?.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 30, 60]);
    expect(result.nativeTracks[1]?.keyframes.map((keyframe) => keyframe.value)).toEqual([20, 80, 120]);
  });

  it("imports exposed 3D transform channels into native tracks instead of legacy-only", () => {
    const result = adaptLegacyGsapAnimations({
      clipId: "clip:camera-a",
      clipStartSeconds: 0,
      frameRate: fps,
      animations: [
        animation({
          id: "legacy:3d",
          properties: { z: 120, rotationX: 12, rotationY: -18, rotationZ: 30, scaleZ: 0.8, transformPerspective: 900 },
          fromProperties: { z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleZ: 1, transformPerspective: 0 },
        }),
      ],
    });

    expect(result.legacyOnly).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.nativeTracks.map((track) => track.parameterId)).toEqual([
      "transform.rotationX",
      "transform.rotationY",
      "transform.rotation",
      "transform.scaleZ",
      "transform.perspective",
      "transform.position.z",
    ]);
  });

  it("imports literal set and zero-duration holds as one key baselines", () => {
    const result = adaptLegacyGsapAnimations({
      clipId: "clip:camera-a",
      clipStartSeconds: 1,
      frameRate: fps,
      animations: [
        animation({
          id: "legacy:set",
          method: "set",
          resolvedStart: 1,
          duration: undefined,
          properties: { opacity: 0.4 },
          fromProperties: undefined,
        }),
        animation({
          id: "legacy:hold",
          method: "to",
          resolvedStart: 1.5,
          duration: 0,
          properties: { scaleX: 1.25 },
          fromProperties: undefined,
        }),
      ],
    });

    expect(result.nativeTracks).toHaveLength(2);
    expect(result.nativeTracks.map((track) => track.parameterId)).toEqual([
      "visual.opacity",
      "transform.scaleX",
    ]);
    expect(result.nativeTracks.map((track) => track.keyframes)).toEqual([
      [expect.objectContaining({ frame: 0, value: 0.4 })],
      [expect.objectContaining({ frame: 15, value: 1.25 })],
    ]);
  });

  it("maps only linear/none and explicit cubic-bezier easing without approximation", () => {
    const cubic = adaptLegacyGsapAnimations({
      clipId: "clip:camera-a",
      clipStartSeconds: 0,
      frameRate: fps,
      animations: [animation({ ease: "cubic-bezier(0.2, 0, 0.8, 1)" })],
    });
    expect(cubic.nativeTracks[0]?.keyframes[0]?.outgoing).toEqual({
      type: "cubic-bezier",
      controlPoints: { x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
    });

    const unsupported = adaptLegacyGsapAnimations({
      clipId: "clip:camera-a",
      clipStartSeconds: 0,
      frameRate: fps,
      animations: [animation({ ease: "power2.inOut" })],
    });
    expect(unsupported.nativeTracks).toEqual([]);
    expect(unsupported.legacyOnly.map((item) => item.id)).toEqual(["legacy:rotation"]);
    expect(unsupported.diagnostics).toContainEqual(
      expect.objectContaining({ animationId: "legacy:rotation", reason: "unsupported-ease" }),
    );
  });

  it.each([
    ["helper", { provenance: { kind: "helper", fn: "spin", callSite: 1 } }],
    ["runtime dynamic", { hasUnresolvedKeyframes: true }],
    ["plugin motion path", { arcPath: { enabled: true, autoRotate: false, segments: [] } }],
    ["dynamic selector", { hasUnresolvedSelector: true }],
    ["non-finite value", { properties: { rotation: Number.NaN } }],
    ["off-frame timing", { resolvedStart: 1 / 59 }],
  ] as const)("keeps %s input legacy-only with a diagnostic", (_name, overrides) => {
    const source = animation(overrides);
    const result = adaptLegacyGsapAnimations({
      clipId: "clip:camera-a",
      clipStartSeconds: 0,
      frameRate: fps,
      animations: [source],
    });

    expect(result.nativeTracks).toEqual([]);
    expect(result.legacyOnly).toEqual([source]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.animationId).toBe(source.id);
  });

  it("never merges sibling source animations, even when they address the same parameter", () => {
    const result = adaptLegacyGsapAnimations({
      clipId: "clip:camera-a",
      clipStartSeconds: 0,
      frameRate: fps,
      animations: [animation({ id: "legacy:a" }), animation({ id: "legacy:b", resolvedStart: 3 })],
    });

    expect(result.nativeTracks).toHaveLength(2);
    expect(result.nativeTracks.map((track) => track.id)).toEqual([
      "native:clip:camera-a:legacy:legacy:a:transform.rotation",
      "native:clip:camera-a:legacy:legacy:b:transform.rotation",
    ]);
  });
});
