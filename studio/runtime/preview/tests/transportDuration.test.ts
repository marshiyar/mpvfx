import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { synchronizeStandaloneTransportDuration } from "../transportDuration";
import { stabilizeStandalonePreviewRuntime } from "../audioStability";
import { coordinateNativePreviewRuntime } from "../nativePicture";

const require = createRequire(import.meta.url);
const publishedRuntime = readFileSync(require.resolve("@hyperframes/core/runtime"), "utf8");

/** Exercise the installed runtime's public transport, including its duration
 * cache, without starting the rest of the browser/media runtime. */
function createTransport(initialDuration = 103.6, initiallyPlaying = false) {
  const source = synchronizeStandaloneTransportDuration(publishedRuntime);
  const start = source.indexOf("Es={");
  const end = source.indexOf(",ws=", start);
  if (start < 0 || end < 0) throw new Error("Published runtime transport boundary changed");

  let clockDuration = initialDuration;
  let documentDuration = initialDuration;
  let currentTime = 0;
  let playing = initiallyPlaying;
  const clock = {
    getDuration: () => clockDuration,
    setDuration: vi.fn((duration: number) => {
      clockDuration = duration;
      currentTime = Math.min(currentTime, duration);
    }),
    isPlaying: () => playing,
    now: () => currentTime,
    reachedEnd: () => currentTime >= clockDuration,
    play: vi.fn(() => { playing = true; return true; }),
    pause: vi.fn(() => { playing = false; }),
    seek: vi.fn((time: number) => { currentTime = Math.min(time, clockDuration); }),
    detachAudioSource: vi.fn(),
  };
  const media = { stopAll: vi.fn() };
  const render = vi.fn();
  const adapterEvent = vi.fn();
  const redraw = vi.fn();
  const transport = new Function("c", "Re", "m", "_t", "Oe", "qe", `
    const e = { canonicalFps: 30, capturedTimeline: {}, currentTime: 0 };
    const jt = (time) => Math.round(time * 30) / 30;
    const at = () => {}, Pe = () => {}, ke = () => {}, ks = () => {};
    const f = false;
    let ms = false;
    let ${source.slice(start, end)};
    return Es;
  `)(clock, () => documentDuration, media, render, adapterEvent, { redraw }) as {
    getDuration(): number;
    getTime(): number;
    isPlaying(): boolean;
    play(): void;
    seek(time: number): void;
    renderSeek(time: number): void;
  };

  return {
    transport, clock, media, render, adapterEvent, redraw,
    changeDuration: (duration: number) => { documentDuration = duration; },
  };
}

describe("standalone transport duration after live timeline edits", () => {
  it("reports the extended document before the next runtime animation frame", () => {
    const { transport, clock, changeDuration } = createTransport();
    changeDuration(107.83);

    expect(transport.getDuration()).toBe(107.83);
    expect(clock.getDuration()).toBe(107.83);
  });

  it.each(["seek", "renderSeek"] as const)("%s reaches a moved clip beyond the cached duration", (method) => {
    const { transport, changeDuration, render } = createTransport();
    changeDuration(119.8);

    transport[method](115);

    expect(transport.getTime()).toBe(115);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0][0]).toBe(115);
  });

  it("retains running media while refreshing duration", () => {
    const { transport, changeDuration, clock, media, render, redraw, adapterEvent } = createTransport(103.6, true);
    changeDuration(119.8);

    expect(transport.getDuration()).toBe(119.8);
    expect(transport.isPlaying()).toBe(true);
    expect(clock.seek).not.toHaveBeenCalled();
    expect(clock.pause).not.toHaveBeenCalled();
    expect(media.stopAll).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(redraw).not.toHaveBeenCalled();
    expect(adapterEvent).not.toHaveBeenCalled();
  });

  it("uses the runtime play path and its media start after a duration refresh", () => {
    const { transport, changeDuration, clock, adapterEvent } = createTransport();
    changeDuration(119.8);

    expect(transport.getDuration()).toBe(119.8);
    transport.play();

    expect(clock.play).toHaveBeenCalledOnce();
    expect(adapterEvent).toHaveBeenCalledWith("play");
  });

  it("updates a shortened paused document while preserving the runtime's playing-duration policy", () => {
    const paused = createTransport();
    paused.changeDuration(80);
    expect(paused.transport.getDuration()).toBe(80);

    const playing = createTransport(103.6, true);
    playing.changeDuration(80);
    expect(playing.transport.getDuration()).toBe(103.6);
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])("keeps a valid duration when live resolution returns %s", (duration) => {
    const { transport, changeDuration } = createTransport();
    changeDuration(duration);
    expect(transport.getDuration()).toBe(103.6);
  });

  it("composes with the installed picture and audio compatibility boundaries", () => {
    expect(() => coordinateNativePreviewRuntime(stabilizeStandalonePreviewRuntime(
      synchronizeStandaloneTransportDuration(publishedRuntime),
    ))).not.toThrow();
  });

  it("fails closed for missing or ambiguous transport boundaries", () => {
    expect(() => synchronizeStandaloneTransportDuration("different runtime")).toThrow();
    expect(() => synchronizeStandaloneTransportDuration(publishedRuntime + publishedRuntime)).toThrow();
  });
});
