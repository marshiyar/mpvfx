import type { PlaybackAdapter } from "./playbackTypes";

type PlayerHost = HTMLElement & {
  ready: boolean;
  currentTime: number;
  duration: number;
  paused: boolean;
  play(): void;
  pause(): void;
  seek(time: number): void;
};

/** The web component keeps a message-backed transport for isolated frames. */
export function createIsolatedPlaybackAdapter(
  iframe: HTMLIFrameElement,
): PlaybackAdapter | null {
  const root = iframe.getRootNode();
  if (!(root instanceof ShadowRoot)) return null;
  const host = root.host as Partial<PlayerHost>;
  if (
    host.localName !== "hyperframes-player" ||
    host.ready !== true ||
    !Number.isFinite(host.duration) ||
    (host.duration ?? 0) <= 0 ||
    typeof host.play !== "function" ||
    typeof host.pause !== "function" ||
    typeof host.seek !== "function"
  )
    return null;
  const player = host as PlayerHost;
  return {
    play: () => player.play(),
    pause: () => player.pause(),
    seek: (time, options) => {
      player.seek(time);
      if (options?.keepPlaying) player.play();
    },
    getTime: () => player.currentTime,
    getDuration: () => player.duration,
    isPlaying: () => !player.paused,
  };
}
