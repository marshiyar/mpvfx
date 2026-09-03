import type { PlaybackAdapter } from "./playbackTypes";

// Reload hydration is performed while the replacement iframe is hidden. Move
// beyond one whole frame at the slowest supported preview/export rate so a
// frame-quantized runtime cannot collapse the guard seek into the target seek.
const FRAME_RENDER_GUARD_SECONDS = 1 / 24 + 0.001;

/** Force transports that ignore same-position seeks to repaint an exact frame. */
export function forceRenderAdapterTime(
  adapter: PlaybackAdapter,
  targetTime: number,
  options?: { keepPlaying?: boolean },
): void {
  const duration = adapter.getDuration();
  const guardTime =
    targetTime > FRAME_RENDER_GUARD_SECONDS
      ? targetTime - FRAME_RENDER_GUARD_SECONDS
      : Number.isFinite(duration) && duration > FRAME_RENDER_GUARD_SECONDS
        ? Math.min(duration, targetTime + FRAME_RENDER_GUARD_SECONDS)
        : targetTime + FRAME_RENDER_GUARD_SECONDS;
  adapter.seek(guardTime, options);
  adapter.seek(targetTime, options);
}

export function shouldResumeForwardPlaybackAfterSeek(input: {
  keepPlaying: boolean;
  wasReverseShuttle: boolean;
  storeWasPlaying: boolean;
  duration: number;
  nextTime: number;
}): boolean {
  return (
    input.keepPlaying &&
    !input.wasReverseShuttle &&
    input.storeWasPlaying &&
    (input.duration <= 0 || input.nextTime < input.duration)
  );
}

export function shouldStopAfterSeek(input: {
  keepPlaying: boolean;
  wasReverseShuttle: boolean;
}): boolean {
  return !input.keepPlaying || input.wasReverseShuttle;
}
