// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createIsolatedPlaybackAdapter } from "../isolatedPlaybackAdapter";

describe("isolated playback adapter", () => {
  it("drives the message-backed player host without touching the frame DOM", () => {
    const host = document.createElement("hyperframes-player");
    const shadow = host.attachShadow({ mode: "open" });
    const iframe = document.createElement("iframe");
    shadow.append(iframe);
    const play = vi.fn();
    const pause = vi.fn();
    const seek = vi.fn();
    Object.assign(host, {
      ready: true,
      duration: 12,
      currentTime: 2,
      paused: true,
      play,
      pause,
      seek,
    });

    const adapter = createIsolatedPlaybackAdapter(iframe);
    expect(adapter?.getDuration()).toBe(12);
    expect(adapter?.getTime()).toBe(2);
    expect(adapter?.isPlaying()).toBe(false);
    adapter?.seek(4, { keepPlaying: true });
    adapter?.pause();
    expect(seek).toHaveBeenCalledWith(4);
    expect(play).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
  });
});
