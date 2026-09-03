// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeVoiceAudioSource, downmixVoiceAudioBuffer } from "./voiceProcessing";

function fakeAudioBuffer(channels: number[][], sampleRate = 48_000): AudioBuffer {
  const data = channels.map((channel) => Float32Array.from(channel));
  return {
    numberOfChannels: data.length,
    length: data[0]?.length ?? 0,
    duration: (data[0]?.length ?? 0) / sampleRate,
    sampleRate,
    getChannelData: (index: number) => {
      const channel = data[index];
      if (!channel) throw new RangeError(`missing channel ${index}`);
      return channel;
    },
  } as unknown as AudioBuffer;
}

function installDecoder(
  decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>,
): ReturnType<typeof vi.fn> {
  const decodeAudioData = vi.fn(decode);
  vi.stubGlobal(
    "OfflineAudioContext",
    class {
      decodeAudioData = decodeAudioData;
    },
  );
  return decodeAudioData;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("voice audio decoding", () => {
  it("downmixes every channel so right-channel-only speech is not treated as silence", () => {
    const result = downmixVoiceAudioBuffer(
      fakeAudioBuffer([
        [0, 0, 0],
        [0.8, -0.6, 0.4],
      ]),
    );

    expect(result[0]).toBeCloseTo(0.4);
    expect(result[1]).toBeCloseTo(-0.3);
    expect(result[2]).toBeCloseTo(0.2);
  });

  it("keeps mono samples unchanged without allocating a second copy", () => {
    const buffer = fakeAudioBuffer([[0.1, -0.2, 0.3]]);
    expect(downmixVoiceAudioBuffer(buffer)).toBe(buffer.getChannelData(0));
  });

  it("resolves project-relative media and forwards cancellation to fetch", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    installDecoder(async () => fakeAudioBuffer([[0.2, 0.4]]));

    const decoded = await decodeVoiceAudioSource({
      document,
      source: "assets/dialogue.wav",
      signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/assets/dialogue.wav",
      expect.objectContaining({ signal }),
    );
    expect(decoded).toMatchObject({ sampleRate: 48_000 });
    expect(decoded!.samples[0]).toBeCloseTo(0.2);
    expect(decoded!.samples[1]).toBeCloseTo(0.4);
  });

  it("rejects a decoder that does not honor the requested analysis sample rate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]))));
    installDecoder(async () => fakeAudioBuffer([[0.2, 0.4]], 44_100));

    await expect(
      decodeVoiceAudioSource({ document, source: "assets/dialogue.wav" }),
    ).rejects.toThrow(/sample rate/i);
  });

  it("rejects an HTTP media error before sending invalid bytes to the decoder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404, statusText: "Not Found" })),
    );
    const decode = installDecoder(async () => fakeAudioBuffer([[0.2]]));

    await expect(
      decodeVoiceAudioSource({ document, source: "assets/missing.wav" }),
    ).rejects.toThrow(/404/);
    expect(decode).not.toHaveBeenCalled();
  });

  it("rejects an abort that lands while decodeAudioData is still running", async () => {
    const controller = new AbortController();
    let finishDecode: ((buffer: AudioBuffer) => void) | null = null;
    const decodeStarted = new Promise<void>((resolveStarted) => {
      installDecoder(
        () =>
          new Promise<AudioBuffer>((resolve) => {
            finishDecode = resolve;
            resolveStarted();
          }),
      );
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]))));

    const pending = decodeVoiceAudioSource({
      document,
      source: "assets/long-voice.wav",
      signal: controller.signal,
    });
    await decodeStarted;
    controller.abort();
    finishDecode?.(fakeAudioBuffer([[0.4, 0.4]]));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns unavailable without fetching when Web Audio is not supported", async () => {
    vi.stubGlobal("OfflineAudioContext", undefined);
    Object.defineProperty(window, "webkitOfflineAudioContext", {
      configurable: true,
      value: undefined,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      decodeVoiceAudioSource({ document, source: "assets/dialogue.wav" }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
