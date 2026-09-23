const STRICT_DRIFT_GUARD = "if(!k&&!oe&&!N&&V&&S>M){";
const PAUSED_MEDIA_STRICT_DRIFT_GUARD = "if(r.paused&&!oe&&!N&&V&&S>M){";
const PLAY_TRANSITION_RESEEK = "e.mediaForceSyncNextTick=!0,ks(c.now()),";
const STABLE_PLAY_TRANSITION = "e.mediaForceSyncNextTick=!0,";
const PAUSE_TRANSITION_RESEEK = "e.mediaForceSyncNextTick=!0,ks(e.currentTime);";
const STABLE_PAUSE_TRANSITION = "e.mediaForceSyncNextTick=!0;";
const STARTING_VIDEO_FORCE_SYNC = "let G=!k&&e.forceSync&&S>.02;";
const STABLE_STARTING_VIDEO_FORCE_SYNC =
  'let G=!k&&!(r.tagName==="VIDEO"&&e.playing&&r.paused)&&e.forceSync&&S>.02;';

function replaceExactlyOnce(
  source: string,
  target: string,
  replacement: string,
  label: string,
): string {
  const matches = source.split(target).length - 1;
  if (matches !== 1) {
    throw new Error(
      matches === 0 ? `${label} was not found` : `${label} must occur exactly once`,
    );
  }
  return source.replace(target, replacement);
}

/**
 * The published runtime's strict drift sampler was written to protect video
 * decoders while they play, but left native audio eligible for a currentTime
 * write every two 50 ms samples. A normal, stable audio-output latency above
 * 40 ms therefore became a seek loop and sounded like jittered gibberish.
 *
 * The published transport also writes `currentTime` unconditionally on every
 * play and pause. Even a same-time assignment starts an asynchronous seek,
 * drops video to HAVE_METADATA, and can clear the painted frame indefinitely
 * in Firefox. Remove those transition-only writes. Explicit seeks, reload
 * hydration, hard drift recovery, and the guarded force-sync path remain.
 */
export function stabilizeStandalonePreviewRuntime(runtimeSource: string): string {
  let stabilized = replaceExactlyOnce(
    runtimeSource,
    STRICT_DRIFT_GUARD,
    PAUSED_MEDIA_STRICT_DRIFT_GUARD,
    "Standalone runtime audio drift synchronization guard",
  );
  stabilized = replaceExactlyOnce(
    stabilized,
    PLAY_TRANSITION_RESEEK,
    STABLE_PLAY_TRANSITION,
    "Standalone runtime play transition guard",
  );
  stabilized = replaceExactlyOnce(
    stabilized,
    PAUSE_TRANSITION_RESEEK,
    STABLE_PAUSE_TRANSITION,
    "Standalone runtime pause transition guard",
  );
  return replaceExactlyOnce(
    stabilized,
    STARTING_VIDEO_FORCE_SYNC,
    STABLE_STARTING_VIDEO_FORCE_SYNC,
    "Standalone runtime starting-video force-sync guard",
  );
}
