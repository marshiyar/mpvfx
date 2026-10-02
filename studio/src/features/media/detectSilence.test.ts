import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeSpeechWithVAD, buildSpeechSegments } from "./detectSilence";

afterEach(() => vi.unstubAllGlobals());

describe("analyzeSpeechWithVAD", () => {
  it("converts model timestamps and analyzes non-first channels", async () => {
    const left = new Float32Array(4_000);
    const right = new Float32Array(4_000);
    vi.stubGlobal("AudioContext", class {
      async decodeAudioData() {
        return {
          duration: 4,
          length: 4_000,
          numberOfChannels: 2,
          sampleRate: 1_000,
          getChannelData: (index: number) => index === 0 ? left : right,
        };
      }
      async close() {}
    });
    const reset = vi.fn();
    const run = vi.fn(async function* (channel: Float32Array) {
      if (channel === right) {
        yield { start: 0, end: 1_000 };
        yield { start: 2_000, end: 4_000 };
      }
    });
    const createVad = vi.fn(async () => ({
      frameProcessor: { reset, resume: vi.fn() },
      run,
    }));
    const file = new File(["fixture"], "voice.mp4");
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(0) });

    const analysis = await analyzeSpeechWithVAD(file, createVad);

    expect(analysis).toEqual({
      duration: 4,
      activeRanges: [
        { start: 0, end: 1 },
        { start: 2, end: 4 },
      ],
    });
    expect(createVad).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("buildSpeechSegments", () => {
  it("removes a 3.5-second pause between spoken sections", () => {
    const segments = buildSpeechSegments({
      duration: 8,
      activeRanges: [
        { start: 0.2, end: 2 },
        { start: 5.5, end: 7.8 },
      ],
    });

    expect(segments).toHaveLength(2);
    expect(segments[0]!.sourceStart).toBeCloseTo(0.02);
    expect(segments[0]!.sourceEnd).toBeCloseTo(2.18);
    expect(segments[1]!.sourceStart).toBeCloseTo(5.32);
    expect(segments[1]!.sourceEnd).toBeCloseTo(7.98);
  });

  it("splits long pauses and keeps configured padding around speech", () => {
    expect(
      buildSpeechSegments(
        {
          duration: 5,
          activeRanges: [
            { start: 0.2, end: 1.8 },
            { start: 3, end: 4.2 },
          ],
        },
        { minimumPauseSeconds: 0.8, paddingSeconds: 0.2 },
      ),
    ).toEqual([
      { sourceStart: 0, sourceEnd: 2 },
      { sourceStart: 2.8, sourceEnd: 4.4 },
    ]);
  });

  it("keeps pauses shorter than the configured minimum", () => {
    expect(
      buildSpeechSegments(
        {
          duration: 3,
          activeRanges: [
            { start: 0.2, end: 1 },
            { start: 1.5, end: 2.5 },
          ],
        },
        { minimumPauseSeconds: 0.8, paddingSeconds: 0.1 },
      ),
    ).toEqual([{ sourceStart: 0.1, sourceEnd: 2.6 }]);
  });

  it("leaves fully silent media untouched", () => {
    expect(buildSpeechSegments({ duration: 4, activeRanges: [] })).toEqual([
      { sourceStart: 0, sourceEnd: 4 },
    ]);
  });

  it("clamps ranges and padding to the source duration", () => {
    expect(
      buildSpeechSegments(
        { duration: 2, activeRanges: [{ start: -1, end: 3 }] },
        { paddingSeconds: 0.2 },
      ),
    ).toEqual([{ sourceStart: 0, sourceEnd: 2 }]);
  });
});