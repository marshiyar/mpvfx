import {
  MAX_AUTOMATION_POINTS,
  parseAutomation,
  sampleAutomationLane,
  serializeAutomation,
  type HfAutomationLane,
} from "@hyperframes/core/audio-automation";
import { describe, expect, it } from "vitest";
import { splitAudioAutomation } from "./splitAudioAutomation";

function splitLane(lane: HfAutomationLane, splitAt: number) {
  const automation = parseAutomation(JSON.stringify({
    version: 1,
    lanes: [lane],
  }));
  const result = splitAudioAutomation(automation, splitAt);
  return {
    source: automation.lanes[0]!,
    left: result.left.lanes[0]!,
    right: result.right.lanes[0]!,
  };
}

function expectEquivalentSamples(
  source: HfAutomationLane,
  splitAt: number,
  left: HfAutomationLane,
  right: HfAutomationLane,
  end: number,
) {
  let maximumError = 0;
  for (let index = 0; index <= 400; index += 1) {
    const time = (splitAt * index) / 400;
    maximumError = Math.max(
      maximumError,
      Math.abs(sampleAutomationLane(left, time) - sampleAutomationLane(source, time)),
    );
  }
  for (let index = 0; index <= 400; index += 1) {
    const localTime = ((end - splitAt) * index) / 400;
    maximumError = Math.max(
      maximumError,
      Math.abs(
        sampleAutomationLane(right, localTime)
          - sampleAutomationLane(source, splitAt + localTime),
      ),
    );
  }
  expect(maximumError).toBeLessThanOrEqual(1e-8);
  for (let index = 0; index <= 40; index += 1) {
    const time = (splitAt * index) / 40;
    expect(sampleAutomationLane(left, time)).toBeCloseTo(
      sampleAutomationLane(source, time),
      8,
    );
  }
  for (let index = 0; index <= 40; index += 1) {
    const localTime = ((end - splitAt) * index) / 40;
    expect(sampleAutomationLane(right, localTime)).toBeCloseTo(
      sampleAutomationLane(source, splitAt + localTime),
      8,
    );
  }
}

describe("splitAudioAutomation nonlinear equivalence", () => {
  it.each([0.7, -0.65])(
    "preserves an exponent curve at every sampled time after an interior split (curve %s)",
    (curve) => {
      const { source, left, right } = splitLane({
        target: "fx.eq.frequency",
        points: [
          { t: 0, v: 0, curve },
          { t: 10, v: 1 },
        ],
      }, 4);

      expectEquivalentSamples(source, 4, left, right, 10);
    },
  );

  it.each([
    { viaX: 0.7, viaY: 0.2 },
    { viaX: 0.25, viaY: 0.8 },
  ])(
    "preserves a via-point curve at every sampled time after an interior split ($viaX, $viaY)",
    ({ viaX, viaY }) => {
      const { source, left, right } = splitLane({
        target: "fx.eq.frequency",
        points: [
          { t: 0, v: 0, curve: -0.4, viaX, viaY },
          { t: 10, v: 1 },
        ],
      }, 4);

      expectEquivalentSamples(source, 4, left, right, 10);
    },
  );

  it("keeps authored boundary metadata and both halves equivalent", () => {
    const { source, left, right } = splitLane({
      target: "fx.eq.frequency",
      points: [
        { t: 0, v: 0, curve: 0.55 },
        { t: 4, v: 0.3, curve: -0.35, viaX: 0.4, viaY: 0.75 },
        { t: 10, v: 1 },
      ],
    }, 4);

    expect(left.points.at(-1)).toEqual(source.points[1]);
    expect(right.points[0]).toEqual({ ...source.points[1], t: 0 });
    expectEquivalentSamples(source, 4, left, right, 10);
  });

  it("survives serialization without exceeding the automation point ceiling", () => {
    const { source, left, right } = splitLane({
      target: "fx.eq.frequency",
      points: [
        { t: 0, v: 0, viaX: 0.7, viaY: 0.2 },
        { t: 10, v: 1 },
      ],
    }, 4);
    const reparsed = parseAutomation(serializeAutomation({
      version: 1,
      lanes: [left, right],
    }));

    expect(reparsed.lanes[0]!.points.length).toBeLessThanOrEqual(MAX_AUTOMATION_POINTS);
    expect(reparsed.lanes[1]!.points.length).toBeLessThanOrEqual(MAX_AUTOMATION_POINTS);
    expectEquivalentSamples(source, 4, reparsed.lanes[0]!, reparsed.lanes[1]!, 10);
  });

  it("rejects explicitly when the point budget cannot preserve a nonlinear cut", () => {
    const points = Array.from({ length: MAX_AUTOMATION_POINTS }, (_, index) => ({
      t: index,
      v: index,
      ...(index === MAX_AUTOMATION_POINTS - 2
        ? { viaX: 0.7, viaY: 0.2 }
        : {}),
    }));
    const automation = parseAutomation(JSON.stringify({
      version: 1,
      lanes: [{ target: "fx.eq.frequency", points }],
    }));

    expect(() => splitAudioAutomation(automation, MAX_AUTOMATION_POINTS - 1.5)).toThrow(
      "cannot be preserved within the 512-point lane limit",
    );
  });
});
