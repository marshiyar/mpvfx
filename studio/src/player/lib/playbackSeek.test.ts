import { describe, expect, it, vi } from "vitest";
import { forceRenderAdapterTime } from "./playbackSeek";
import type { PlaybackAdapter } from "./playbackTypes";

function adapterAt(time: number, duration: number) {
  let currentTime = time;
  const seek = vi.fn((nextTime: number) => {
    currentTime = nextTime;
  });
  const adapter: PlaybackAdapter = {
    play: vi.fn(),
    pause: vi.fn(),
    seek,
    getTime: () => currentTime,
    getDuration: () => duration,
    isPlaying: () => false,
  };
  return { adapter, seek };
}

describe("forceRenderAdapterTime", () => {
  it("uses a forward guard at the zero boundary before restoring zero", () => {
    const { adapter, seek } = adapterAt(0, 30);

    forceRenderAdapterTime(adapter, 0);

    const [guardTime, restoredTime] = seek.mock.calls.map(([time]) => time);
    expect(guardTime).toBeGreaterThan(1 / 24);
    expect(restoredTime).toBe(0);
    expect(adapter.getTime()).toBe(0);
  });

  it("uses a backward guard near the duration before restoring the exact time", () => {
    const { adapter, seek } = adapterAt(29.999, 30);

    forceRenderAdapterTime(adapter, 29.999);

    expect(seek).toHaveBeenCalledTimes(2);
    expect(29.999 - (seek.mock.calls[0]?.[0] ?? 29.999)).toBeGreaterThan(1 / 24);
    expect(seek.mock.calls[1]?.[0]).toBe(29.999);
    expect(adapter.getTime()).toBe(29.999);
  });

  it.each([24, 30, 60])(
    "crosses a distinct frame in a runtime that quantizes seeks to %i fps",
    (fps) => {
      const targetTime = 8.26;
      let currentFrame = Math.floor(targetTime * fps);
      const renderedFrames: number[] = [];
      const adapter: PlaybackAdapter = {
        play: vi.fn(),
        pause: vi.fn(),
        seek: vi.fn((time: number) => {
          const frame = Math.floor(time * fps);
          if (frame !== currentFrame) renderedFrames.push(frame);
          currentFrame = frame;
        }),
        getTime: () => currentFrame / fps,
        getDuration: () => 30,
        isPlaying: () => false,
      };

      forceRenderAdapterTime(adapter, targetTime);

      expect(renderedFrames).toHaveLength(2);
      expect(renderedFrames[0]).not.toBe(renderedFrames[1]);
      expect(currentFrame).toBe(Math.floor(targetTime * fps));
    },
  );
});
