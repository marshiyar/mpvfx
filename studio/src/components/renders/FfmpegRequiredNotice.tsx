import { memo, useEffect, useRef, useState } from "react";
import type { FfmpegStatus } from "./useFfmpegStatus";

const CUE_MS = 1600;

// Matches the focus treatment every other button in this panel uses. A control
// the keyboard can reach but not see focus on is unusable without a mouse.
const FOCUS_RING =
  "outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-studio-accent";

/**
 * Shown above Export when the application cannot use its packaged media
 * runtime. MpVFX never asks the user to install or locate a system FFmpeg.
 */
export const FfmpegRequiredNotice = memo(function FfmpegRequiredNotice({
  status,
  checking,
  onRecheck,
}: {
  status: FfmpegStatus;
  checking: boolean;
  onRecheck: () => void;
}) {
  // A recheck that finds nothing changes no other pixel on screen, so without
  // this the button reads as broken at the exact moment the user is most
  // unsure. Motion alone would not do: the result has to survive being missed.
  const [recheckFailed, setRecheckFailed] = useState(false);
  const wasChecking = useRef(false);
  const cueTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    // Still mounted after a check finished means the answer was "still no":
    // a success unmounts this card entirely.
    if (wasChecking.current && !checking) setRecheckFailed(true);
    wasChecking.current = checking;
  }, [checking]);

  useEffect(() => {
    if (!recheckFailed) return;
    cueTimer.current = setTimeout(() => setRecheckFailed(false), CUE_MS);
    return () => clearTimeout(cueTimer.current);
  }, [recheckFailed]);

  useEffect(() => () => clearTimeout(cueTimer.current), []);

  // Concentric: outer radius (12) minus padding (10) equals the inner radius
  // (2). Mismatched nesting here is what makes a card look subtly wrong.
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5"
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] font-semibold text-amber-300">
          {status.title ?? "Bundled media tools unavailable"}
        </span>
        {/* text-2, not the panel's usual text-4 for secondary copy: the amber
            wash lifts the background, and text-4 measures 2.2:1 on it against
            the 4.5:1 minimum. This is the line that explains why Export is
            off, so it has to be readable. text-2 measures 6.6:1. */}
        <span className="text-[10px] leading-snug text-pretty text-panel-text-2">
          {status.detail ?? "MpVFX cannot access its bundled media tools."}
        </span>
      </div>

      {status.hint && (
        <span className="text-[10px] leading-snug text-pretty text-panel-text-2">
          {status.hint}
        </span>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onRecheck}
          disabled={checking}
          className={`rounded-sm py-0.5 text-[10px] font-medium text-amber-200 underline-offset-2 transition-colors hover:underline disabled:opacity-50 ${FOCUS_RING}`}
        >
          {checking ? "Checking…" : "Recheck"}
        </button>
        {/* Last in the row and only ever appended, so appearing and vanishing
            moves nothing that sits before it. */}
        <span
          aria-live="polite"
          className="ml-auto text-[10px] text-panel-text-2 transition-opacity"
        >
          {recheckFailed ? "Still unavailable" : ""}
        </span>
      </div>
    </div>
  );
});
