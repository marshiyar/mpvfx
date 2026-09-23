const DURATION_READ =
  "getDuration:()=>{let d=c.getDuration();return Number.isFinite(d)?d:0}";
const LIVE_DURATION_READ =
  "getDuration:()=>{let h=Re(e.capturedTimeline,0);" +
  "Number.isFinite(h)&&h>0&&(!c.isPlaying()||h>=c.getDuration())&&c.setDuration(h);" +
  "let d=c.getDuration();return Number.isFinite(d)?d:0}";
const SEEK_BOUNDARY =
  "let g=jt(Math.max(0,Number(d)||0),e.canonicalFps);m.stopAll()";

/**
 * Live timing edits change the document before the runtime's next frame updates
 * its cached clock duration. Reading that old value makes Studio replace the
 * audio/video transport with a seek-only fallback; seeking also clamps to the
 * old end. Resolve duration at these public boundaries using the runtime's
 * existing document/media resolver and its existing no-shrink-during-play rule.
 * Updating the clock's limit does not seek, pause, or redraw media.
 */
export function synchronizeStandaloneTransportDuration(source: string): string {
  if (source.split(DURATION_READ).length !== 2) {
    throw new Error("Standalone transport duration read must occur exactly once");
  }
  if (source.split(SEEK_BOUNDARY).length !== 3) {
    throw new Error("Standalone transport seek boundary must occur exactly twice");
  }
  return source
    .replace(DURATION_READ, LIVE_DURATION_READ)
    .split(SEEK_BOUNDARY)
    .join(`Es.getDuration();${SEEK_BOUNDARY}`);
}
