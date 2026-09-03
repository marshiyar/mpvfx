// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { carveLanes, measureCarve, mintCarveNodes } from "./useFxCarveNodes";

const SAMPLE_RATE = 48_000;

function speech(): Float32Array {
  return Float32Array.from({ length: SAMPLE_RATE }, (_, index) =>
    0.5 * Math.sin((2 * Math.PI * 600 * index) / SAMPLE_RATE),
  );
}

function installOfflineDecoder(): void {
  const samples = speech();
  vi.stubGlobal(
    "OfflineAudioContext",
    class {
      async decodeAudioData(): Promise<AudioBuffer> {
        return {
          numberOfChannels: 1,
          length: samples.length,
          duration: 1,
          sampleRate: SAMPLE_RATE,
          getChannelData: () => samples,
        } as unknown as AudioBuffer;
      }
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voice carve measurement resilience", () => {
  it("uses the readable speakers when one selected voice source fails", async () => {
    installOfflineDecoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("missing")) throw new TypeError("media offline");
        return new Response(new Uint8Array([1]));
      }),
    );

    const measured = await measureCarve(
      document,
      [
        { src: "assets/missing.wav", start: "0" },
        { src: "assets/narrator.wav", start: "0" },
      ],
      0.5,
      "0",
      null,
    );

    expect(measured).not.toBeNull();
    expect(measured!.voiceMix.some((sample) => Math.abs(sample) > 0)).toBe(true);
  });

  it("returns no measurement when every selected voice is unreadable", async () => {
    installOfflineDecoder();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));

    await expect(
      measureCarve(
        document,
        [
          { src: "assets/a.wav", start: "0" },
          { src: "assets/b.wav", start: "4" },
        ],
        0.5,
        "0",
        null,
      ),
    ).resolves.toBeNull();
  });

  it("propagates cancellation instead of converting it into a partial carve", async () => {
    installOfflineDecoder();
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );

    const pending = measureCarve(
      document,
      [{ src: "assets/long.wav", start: "0" }],
      0.5,
      "0",
      null,
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("voice carve derived graph", () => {
  it("replaces prior generated nodes while preserving the author's effects", () => {
    const result = mintCarveNodes(
      {
        version: 1,
        nodes: [
          { type: "gain", id: "old", enabled: true, fromCarve: true, params: { gain: -4 } },
          { type: "lowpass", id: "kept", enabled: true, params: { frequency: 900 } },
        ],
      },
      {
        version: 1,
        nodes: [{ type: "peaking", enabled: true, params: { frequency: 1200, gain: -6, q: 1 } }],
      },
      [{ t: 0, v: -3 }, { t: 1, v: 0 }],
    );

    expect(result.next.nodes.at(-1)?.id).toBe("kept");
    expect(result.next.nodes.some((node) => node.id === "old")).toBe(false);
    expect(result.carvedNodes.every((node) => node.fromCarve && node.id)).toBe(true);
    expect(result.duckNode).toMatchObject({ type: "gain", fromCarve: true });
  });

  it("anchors a delayed speech envelope at zero and discards negative time", () => {
    const lanes = carveLanes(
      [{ type: "peaking", id: "band", enabled: true, params: { gain: -6 } }],
      { type: "gain", id: "duck", enabled: true, params: { gain: 0 } },
      [
        { t: -1, v: -4 },
        { t: 2, v: -4 },
        { t: 3, v: 0 },
      ],
      new Float32Array(0),
      [],
    );

    expect(lanes).toEqual([
      {
        target: "fx.duck.gain",
        points: [
          { t: 0, v: 0 },
          { t: 2, v: -4 },
          { t: 3, v: 0 },
        ],
      },
    ]);
  });
});
