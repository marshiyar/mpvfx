import { useCallback, useEffect, useRef, useState } from "react";

/**
 * What the application server knows about MpVFX's bundled FFmpeg, as reported by
 * `GET /api/environment/ffmpeg`. Studio asks when the Render panel opens so a
 * damaged installation is reported before an export starts.
 */
export interface FfmpegStatus {
  ok: boolean;
  /** Short headline. Absent when ok. */
  title?: string;
  /** Why it cannot run, in the server's words. Absent when ok. */
  detail?: string;
  /** Prose remediation for repairing the application bundle. */
  hint?: string;
}

/**
 * `null` means "no answer", NOT "missing". An unreachable or older dev server
 * is not evidence that FFmpeg is absent, and blocking Export on a failed probe
 * would lock out people whose setup is fine. Unknown always fails open.
 */
type ProbeResult = FfmpegStatus | null;

/**
 * One line naming the problem and the application-level repair for the render
 * row Studio writes when it refuses to start.
 */
export function ffmpegInstallMessage(status: FfmpegStatus | null): string {
  const title = status?.title ?? "Bundled media tools unavailable";
  const remedy = status?.hint ?? "Reinstall MpVFX to restore its bundled media tools.";
  return `${title}. ${remedy}`;
}

// The Render panel unmounts on every right-panel tab switch, and each miss
// re-probes the filesystem server-side. Remember the answer for the tab's life.
let cached: ProbeResult = null;

const asText = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/** Parses the endpoint's answer, or `null` for anything that is not one. */
function parseStatus(body: unknown): ProbeResult {
  if (typeof body !== "object" || body === null) return null;
  const { ok, title, detail, hint } = body as Record<string, unknown>;
  if (typeof ok !== "boolean") return null;
  return {
    ok,
    title: asText(title),
    detail: asText(detail),
    hint: asText(hint),
  };
}

async function probe(): Promise<ProbeResult> {
  try {
    const res = await fetch("/api/environment/ffmpeg");
    return res.ok ? parseStatus(await res.json()) : null;
  } catch {
    return null;
  }
}

export function useFfmpegStatus(): {
  status: ProbeResult;
  checking: boolean;
  recheck: () => void;
} {
  const [status, setStatus] = useState<ProbeResult>(cached);
  const [checking, setChecking] = useState(cached === null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    setChecking(true);
    const next = await probe();
    cached = next;
    if (!mounted.current) return;
    setStatus(next);
    setChecking(false);
  }, []);

  useEffect(() => {
    if (cached !== null) return;
    void run();
  }, [run]);

  // A repaired/reinstalled application can ask the server to probe its bundled
  // runtime again without retaining a stale result in this mounted view.
  const recheck = useCallback(() => {
    cached = null;
    void run();
  }, [run]);

  return { status, checking, recheck };
}
