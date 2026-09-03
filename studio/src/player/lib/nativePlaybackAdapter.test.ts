// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createNativeParameterTrack } from "../../project/nativeKeyframeTypes";
import {
  createNativePlaybackAdapter,
  selectPreferredNativePlaybackAdapter,
} from "./nativePlaybackAdapter";
import type { PlaybackAdapter, StaticSeekPlaybackClock } from "./playbackTypes";

function fakeClock(): StaticSeekPlaybackClock & {
  advanceTo: (milliseconds: number) => void;
  runNext: () => void;
} {
  let now = 0;
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    now: () => now,
    requestAnimationFrame: (callback) => {
      nextId += 1;
      callbacks.set(nextId, callback);
      return nextId;
    },
    cancelAnimationFrame: (handle) => {
      callbacks.delete(handle);
    },
    advanceTo: (milliseconds) => {
      now = milliseconds;
    },
    runNext: () => {
      const entry = callbacks.entries().next();
      if (entry.done) throw new Error("No native playback frame was scheduled");
      const [handle, callback] = entry.value;
      callbacks.delete(handle);
      callback(now);
    },
  };
}

function nativeClip() {
  return {
    clipId: "clip-1",
    startFrame: 30,
    durationFrames: 91,
    parameterTracks: [
      createNativeParameterTrack({
        id: "rotation",
        parameterId: "transform.rotation",
        valueType: "number" as const,
        frameRate: { numerator: 30, denominator: 1 },
        keyframes: [
          { id: "start", frame: 0, value: 0, outgoing: { type: "linear" as const } },
          { id: "end", frame: 90, value: -180, outgoing: { type: "linear" as const } },
        ],
      }),
    ],
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  const element = document.createElement("div");
  element.setAttribute("data-studio-clip-id", "clip-1");
  document.body.appendChild(element);
});

describe("createNativePlaybackAdapter", () => {
  it("quantizes seconds with the rational project rate and renders through the shared evaluator", () => {
    const clock = fakeClock();
    const adapter = createNativePlaybackAdapter({
      document,
      frameRate: { numerator: 30, denominator: 1 },
      durationFrames: 121,
      clips: [nativeClip()],
      clock,
    });

    adapter.seek(2.5);

    expect(adapter.getTime()).toBe(2.5);
    expect(document.querySelector<HTMLElement>("[data-studio-clip-id]")?.style.transform).toContain(
      "rotate(-90deg)",
    );
    expect(adapter.getDuration()).toBeCloseTo(121 / 30, 10);
  });

  it("pause retains the exact rendered frame and repeated seek is byte-identical", () => {
    const adapter = createNativePlaybackAdapter({
      document,
      frameRate: { numerator: 30, denominator: 1 },
      durationFrames: 121,
      clips: [nativeClip()],
      clock: fakeClock(),
    });
    const element = document.querySelector<HTMLElement>("[data-studio-clip-id]")!;

    adapter.seek(2.5);
    const pausedFrame = element.getAttribute("style");
    adapter.pause();
    expect(element.getAttribute("style")).toBe(pausedFrame);
    adapter.seek(2.5);
    expect(element.getAttribute("style")).toBe(pausedFrame);
  });

  it("advances monotonically from the adapter clock without React-driven frame writes", () => {
    const clock = fakeClock();
    const adapter = createNativePlaybackAdapter({
      document,
      frameRate: { numerator: 30, denominator: 1 },
      durationFrames: 121,
      clips: [nativeClip()],
      clock,
    });

    adapter.play();
    clock.advanceTo(2_500);
    clock.runNext();

    expect(adapter.getTime()).toBe(2.5);
    expect(document.querySelector<HTMLElement>("[data-studio-clip-id]")?.style.transform).toContain(
      "rotate(-90deg)",
    );
  });

  it("keeps the legacy media/audio transport running while native picture parameters evaluate", () => {
    const base = {
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      getTime: vi.fn(() => 0),
      getDuration: vi.fn(() => 121 / 30),
      isPlaying: vi.fn(() => false),
    } satisfies PlaybackAdapter;
    const adapter = createNativePlaybackAdapter({
      document,
      frameRate: { numerator: 30, denominator: 1 },
      durationFrames: 121,
      clips: [nativeClip()],
      clock: fakeClock(),
      baseAdapter: base,
    });

    adapter.seek(2.5);
    expect(base.seek).toHaveBeenCalledWith(2.5, undefined);
    expect(document.querySelector<HTMLElement>("[data-studio-clip-id]")?.style.transform).toContain(
      "rotate(-90deg)",
    );

    adapter.play();
    expect(base.play).toHaveBeenCalledTimes(1);
    expect(adapter.isPlaying()).toBe(true);

    adapter.pause();
    expect(base.pause).toHaveBeenCalledTimes(1);
    expect(adapter.isPlaying()).toBe(false);
  });

  it("applies native source timing, speed, mute, and visibility after the base adapter on seek/play/pause", () => {
    document.body.replaceChildren();
    const clipRoot = document.createElement("div");
    clipRoot.setAttribute("data-studio-clip-id", "clip-1");
    const media = document.createElement("video");
    clipRoot.append(media);
    document.body.append(clipRoot);
    const corruptMediaState = () => {
      media.currentTime = 99;
      media.playbackRate = 1;
      media.muted = false;
    };
    const base = {
      play: vi.fn(corruptMediaState),
      pause: vi.fn(corruptMediaState),
      seek: vi.fn(corruptMediaState),
      getTime: vi.fn(() => 0),
      getDuration: vi.fn(() => 10),
      isPlaying: vi.fn(() => false),
    } satisfies PlaybackAdapter;
    const adapter = createNativePlaybackAdapter({
      document,
      frameRate: { numerator: 30, denominator: 1 },
      durationFrames: 180,
      clips: [{
        ...nativeClip(),
        assetId: "asset-1",
        assetKind: "video",
        sourceInFrame: 15,
        playbackRate: { numerator: 3, denominator: 2 },
        muted: true,
      }],
      clock: fakeClock(),
      baseAdapter: base,
    });

    adapter.seek(2);
    expect(clipRoot.style.visibility).toBe("visible");
    expect(media.currentTime).toBeCloseTo(2, 10);
    expect(media.playbackRate).toBe(1.5);
    expect(media.muted).toBe(true);

    adapter.play();
    expect(media.currentTime).toBeCloseTo(2, 10);
    expect(media.playbackRate).toBe(1.5);
    expect(media.muted).toBe(true);

    adapter.pause();
    expect(media.currentTime).toBeCloseTo(2, 10);
    expect(media.playbackRate).toBe(1.5);
    expect(media.muted).toBe(true);

    adapter.seek(0);
    expect(clipRoot.style.visibility).toBe("hidden");
  });

  it("does not continuously force currentTime while native-owned media is playing", () => {
    document.body.replaceChildren();
    const media = document.createElement("video");
    media.setAttribute("data-studio-clip-id", "clip-1");
    document.body.append(media);
    const clock = fakeClock();
    const adapter = createNativePlaybackAdapter({
      document,
      frameRate: { numerator: 30, denominator: 1 },
      durationFrames: 180,
      clips: [{
        ...nativeClip(),
        assetId: "asset-1",
        assetKind: "video",
        sourceInFrame: 0,
        playbackRate: 1,
        muted: false,
      }],
      clock,
    });

    adapter.seek(2);
    adapter.play();
    media.currentTime = 2.25;
    clock.advanceTo(100);
    clock.runNext();

    expect(media.currentTime).toBe(2.25);
    expect(media.muted).toBe(false);
  });

  it("synchronizes source time once when playback enters a later clip and silences it while inactive", () => {
    document.body.replaceChildren();
    const media = document.createElement("audio");
    media.setAttribute("data-studio-clip-id", "clip-1");
    document.body.append(media);
    const clock = fakeClock();
    const adapter = createNativePlaybackAdapter({
      document,
      frameRate: { numerator: 30, denominator: 1 },
      durationFrames: 180,
      clips: [{
        ...nativeClip(),
        assetId: "asset-1",
        assetKind: "audio",
        sourceInFrame: 15,
        playbackRate: { numerator: 1, denominator: 1 },
        muted: false,
      }],
      clock,
    });

    expect(media.style.visibility).toBe("hidden");
    expect(media.muted).toBe(true);
    adapter.play();
    media.currentTime = 99;
    clock.advanceTo(1_000);
    clock.runNext();
    expect(media.style.visibility).toBe("visible");
    expect(media.currentTime).toBeCloseTo(0.5, 10);
    expect(media.muted).toBe(false);

    media.currentTime = 0.6;
    clock.advanceTo(1_100);
    clock.runNext();
    expect(media.currentTime).toBe(0.6);
  });

  it("leaves media transport properties untouched when native transport metadata is absent", () => {
    const media = document.createElement("video");
    media.setAttribute("data-studio-clip-id", "clip-1");
    document.body.replaceChildren(media);
    media.currentTime = 4;
    media.playbackRate = 1.25;
    media.muted = true;
    const adapter = createNativePlaybackAdapter({
      document,
      frameRate: { numerator: 30, denominator: 1 },
      durationFrames: 121,
      clips: [nativeClip()],
      clock: fakeClock(),
    });

    adapter.seek(2.5);

    expect(media.currentTime).toBe(4);
    expect(media.playbackRate).toBe(1.25);
    expect(media.muted).toBe(true);
  });

  it("covers a longer legacy composition while continuing to apply native frames", () => {
    const base = {
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      getTime: vi.fn(() => 0),
      getDuration: vi.fn(() => 20),
      isPlaying: vi.fn(() => false),
    } satisfies PlaybackAdapter;
    const adapter = createNativePlaybackAdapter({
      document,
      frameRate: { numerator: 30, denominator: 1 },
      durationFrames: 121,
      clips: [nativeClip()],
      clock: fakeClock(),
      baseAdapter: base,
    });
    const element = document.querySelector<HTMLElement>("[data-studio-clip-id]")!;

    expect(adapter.getDuration()).toBe(20);
    expect(selectPreferredNativePlaybackAdapter({ __studioNativePlayer: adapter }, 20)).toBe(
      adapter,
    );
    adapter.seek(10);
    expect(base.seek).toHaveBeenCalledWith(10, undefined);
    expect(element.style.visibility).toBe("hidden");
  });
});

describe("selectPreferredNativePlaybackAdapter", () => {
  it("selects a covering native adapter ahead of a legacy player", () => {
    const native = {
      play() {},
      pause() {},
      seek() {},
      getTime: () => 0,
      getDuration: () => 10,
      isPlaying: () => false,
    } satisfies PlaybackAdapter;
    const legacy = { ...native, getDuration: () => 20 };

    expect(
      selectPreferredNativePlaybackAdapter(
        { __studioNativePlayer: native, __player: legacy },
        9,
      ),
    ).toBe(native);
  });

  it("returns null when native playback is absent or cannot cover the document", () => {
    const shortNative = {
      play() {},
      pause() {},
      seek() {},
      getTime: () => 0,
      getDuration: () => 2,
      isPlaying: () => false,
    } satisfies PlaybackAdapter;

    expect(selectPreferredNativePlaybackAdapter({}, 1)).toBeNull();
    expect(selectPreferredNativePlaybackAdapter({ __studioNativePlayer: shortNative }, 3)).toBeNull();
  });
});
