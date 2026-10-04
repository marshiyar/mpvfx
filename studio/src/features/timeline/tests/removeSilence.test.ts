import { describe, expect, it } from "vitest";
import { detectSilences, planSilenceRemoval } from "../removeSilence";

describe("detectSilences", () => {
  it("finds padded low-RMS ranges between active audio", () => {
    const samples = new Float32Array(2_000);
    samples.fill(0.1, 0, 200);
    samples.fill(0.005, 200, 1_800);
    samples.fill(0.1, 1_800);

    const silences = detectSilences([samples], 1_000);
    expect(silences).toHaveLength(1);
    expect(silences[0]?.start).toBeCloseTo(0.32);
    expect(silences[0]?.end).toBeCloseTo(1.68);
  });

  it("keeps quiet speech above the threshold", () => {
    const samples = new Float32Array(1_000);
    samples.fill(0.01);

    expect(detectSilences([samples], 1_000)).toEqual([]);
  });

  it("ignores pauses shorter than the configured minimum", () => {
    const samples = new Float32Array(1_000);
    samples.fill(0.1, 0, 250);
    samples.fill(0.005, 250, 750);
    samples.fill(0.1, 750);

    expect(detectSilences([samples], 1_000)).toEqual([]);
  });
});

describe("planSilenceRemoval", () => {
  it("maps source ranges through trim and playback rate, and returns ordered cuts", () => {
    const plan = planSilenceRemoval(
      { start: 10, duration: 5, playbackStart: 2, playbackRate: 2 },
      [
        { start: 4, end: 6 },
        { start: 10, end: 12 },
      ],
    );

    expect(plan).toEqual({
      cutTimes: [11, 12, 14],
      removedRanges: [
        { start: 11, end: 12 },
        { start: 14, end: 15 },
      ],
      segments: [
        { start: 10, end: 11, remove: false },
        { start: 11, end: 12, remove: true },
        { start: 12, end: 14, remove: false },
        { start: 14, end: 15, remove: true },
      ],
      removedSeconds: 2,
    });
  });

  it("keeps the full clip when no silence is detected", () => {
    expect(planSilenceRemoval({ start: 2, duration: 3 }, [])).toMatchObject({
      cutTimes: [],
      removedRanges: [],
      segments: [{ start: 2, end: 5, remove: false }],
      removedSeconds: 0,
    });
  });
});