import { describe, expect, it } from "vitest";
import { gsap } from "gsap";
import { installStudioCustomEase } from "@hyperframes/core/runtime/custom-ease";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";

import { evaluateNativeParameterTrack } from "../../../shared/project/nativeKeyframeEvaluator";
import { adaptLegacyGsapAnimations } from "./legacyGsapKeyframeAdapter";

const fps = { numerator: 30, denominator: 1 };
// The studio runtime's own ease resolver, so custom() plays as it does in the app.
installStudioCustomEase(gsap);

function animation(overrides: Partial<GsapAnimation>): GsapAnimation {
  return {
    id: "legacy:rotation",
    targetSelector: "#not-a-native-id",
    method: "fromTo",
    position: 0,
    resolvedStart: 0,
    duration: 3,
    ease: "none",
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
              { percentage: 100, properties: { x: 100, y: 120 }, ease: "none" },
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

  it("maps eases with an exact cubic form and keeps the rest legacy-only", () => {
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
      animations: [animation({ ease: "elastic.out(1, 0.3)" })],
    });
    expect(unsupported.nativeTracks).toEqual([]);
    expect(unsupported.legacyOnly.map((item) => item.id)).toEqual(["legacy:rotation"]);
    expect(unsupported.diagnostics).toContainEqual(
      expect.objectContaining({ animationId: "legacy:rotation", reason: "unsupported-ease" }),
    );
  });

  // What GSAP itself plays, frame by frame, is the reference for every import.
  function gsapFrames(vars: gsap.TweenVars, frames: number): number[] {
    const target = { rotation: 0 };
    const tween = gsap.fromTo(target, { rotation: 0 }, { ...vars, paused: true });
    const duration = tween.duration();
    return Array.from({ length: frames + 1 }, (_, frame) => {
      tween.seek(Math.min(frame / 30, duration));
      return target.rotation;
    });
  }

  it.each([
    ["omitted (GSAP default power1.out)", undefined],
    ["power1.in", "power1.in"],
    ["quad.out", "quad.out"],
    ["power2.out", "power2.out"],
    ["power2.inOut", "power2.inOut"],
    ["power1.inOut", "power1.inOut"],
    ["studio custom()", "custom(M0,0 C1,1.6 1,-1 1,1)"],
  ] as const)("plays a %s tween exactly like GSAP at every frame", (_name, ease) => {
    const result = adaptLegacyGsapAnimations({
      clipId: "clip:camera-a",
      clipStartSeconds: 0,
      frameRate: fps,
      animations: [animation({ ease, duration: 3 })],
    });
    expect(result.diagnostics).toEqual([]);
    const expected = gsapFrames({ rotation: -180, duration: 3, ...(ease ? { ease } : {}) }, 90);
    expected.forEach((value, frame) => {
      expect(evaluateNativeParameterTrack(result.nativeTracks[0]!, frame)).toBeCloseTo(value, 4);
    });
  });

  function percentageRun(keyframes: { percentage: number; properties: { rotation: number }; ease?: string }[], seconds: number) {
    const result = adaptLegacyGsapAnimations({
      clipId: "clip:camera-a",
      clipStartSeconds: 0,
      frameRate: fps,
      animations: [animation({
        method: "to", ease: undefined, duration: seconds, properties: {}, fromProperties: undefined,
        keyframes: { format: "percentage", keyframes },
      })],
    });
    const target = { rotation: 0 };
    const tween = gsap.to(target, {
      keyframes: Object.fromEntries(keyframes.map((key) => [`${key.percentage}%`, { ...key.properties, ...(key.ease ? { ease: key.ease } : {}) }])),
      duration: seconds,
      paused: true,
    });
    const errors = Array.from({ length: seconds * 30 + 1 }, (_, frame) => {
      tween.seek(frame / 30);
      return Math.abs(evaluateNativeParameterTrack(result.nativeTracks[0]!, frame) - target.rotation);
    });
    return { result, maxError: Math.max(...errors) };
  }

  it("eases each percentage segment by its destination key, defaulting to power1.inOut", () => {
    const { result, maxError } = percentageRun([
      { percentage: 0, properties: { rotation: 0 } },
      { percentage: 50, properties: { rotation: -90 }, ease: "power2.in" },
      { percentage: 100, properties: { rotation: -180 } },
    ], 2);
    expect(result.diagnostics).toEqual([]);
    expect(maxError).toBeLessThan(1e-4);
  });

  it("snaps an inOut midpoint that falls between frames to the frame it falls in", () => {
    // 45-frame segment: its midpoint 22.5 snaps to 22, a sub-frame shift.
    const { result, maxError } = percentageRun([
      { percentage: 0, properties: { rotation: 0 } },
      { percentage: 100, properties: { rotation: -180 } },
    ], 1.5);
    expect(result.diagnostics).toEqual([]);
    expect(maxError).toBeLessThan(180 * 0.005);
  });

  it.each([
    ["helper", { provenance: { kind: "helper", fn: "spin", callSite: 1 } }],
    ["runtime dynamic", { hasUnresolvedKeyframes: true }],
    ["plugin motion path", { arcPath: { enabled: true, autoRotate: false, segments: [] } }],
    ["dynamic selector", { hasUnresolvedSelector: true }],
    ["non-finite value", { properties: { rotation: Number.NaN } }],
    ["sub-frame tween", { duration: 1 / 60 }],
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

  it("maps authored times to the project frame they fall in, like adopted clip starts", () => {
    // HTML clip at 0.57s is adopted at frame 17 (floor of 17.1); its own set at
    // 0.57s must stay on local frame 0 rather than be dropped as off-frame.
    const result = adaptLegacyGsapAnimations({
      clipId: "clip:camera-a",
      clipStartSeconds: 17 / 30,
      frameRate: fps,
      animations: [
        animation({ id: "legacy:hold", method: "set", resolvedStart: 0.57, duration: 0, properties: { scale: 0.5 }, fromProperties: undefined }),
        animation({ id: "legacy:spin", resolvedStart: 0.57, duration: 1.01 }),
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.nativeTracks.map((track) => [track.parameterId, track.keyframes.map((keyframe) => keyframe.frame)])).toEqual([
      ["transform.scale", [0]],
      ["transform.rotation", [0, 30]],
    ]);
  });

  it("holds a set authored before the clip as the clip's starting value", () => {
    // gsap.set outside the timeline applies at load (resolved start 0).
    const result = adaptLegacyGsapAnimations({
      clipId: "clip:camera-a",
      clipStartSeconds: 2,
      clipDurationFrames: 90,
      frameRate: fps,
      animations: [animation({ method: "set", resolvedStart: 0, duration: 0, properties: { x: 87 }, fromProperties: undefined })],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.nativeTracks[0]?.keyframes.map((key) => [key.frame, key.value])).toEqual([[0, 87]]);
  });

  it("cuts a tween reaching outside the clip exactly where the clip starts and ends", () => {
    // 0→-180 over frames 0..90 in project time; the clip spans frames 30..60.
    const result = adaptLegacyGsapAnimations({
      clipId: "clip:camera-a",
      clipStartSeconds: 1,
      clipDurationFrames: 30,
      frameRate: fps,
      animations: [animation({})],
    });
    expect(result.diagnostics).toEqual([]);
    const track = result.nativeTracks[0]!;
    expect(track.keyframes.map((key) => key.frame)).toEqual([0, 30]);
    for (const frame of [0, 10, 30]) {
      expect(evaluateNativeParameterTrack(track, frame)).toBeCloseTo(-2 * (frame + 30), 9);
    }
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
