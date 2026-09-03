import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { CanvasResolution } from "@hyperframes/parsers";
import { trackStudioRenderStart } from "../../telemetry/events";
import { getAnonymousId } from "../../telemetry/config";
import { browserTelemetryAllowed } from "../../telemetry/policy";
import { generateId } from "../../utils/generateId";
import { readServerError } from "./serverError";
import { ffmpegInstallMessage, useFfmpegStatus } from "./useFfmpegStatus";
import { requestStudioFeedback, type FeedbackContext } from "../feedback/feedbackTrigger";
import {
  EXPORT_FORMAT_CAPABILITIES,
  isExportFormat,
  isExportFrameRate,
  isValidExportOutputDimensions,
  isExportQuality,
  type ExportDimensions,
  type ExportFormat,
  type ExportFrameRate,
  type ExportQuality,
} from "../../utils/exportPolicy";

export interface RenderJob {
  id: string;
  status: "rendering" | "complete" | "failed" | "cancelled";
  progress: number;
  stage?: string;
  error?: string;
  filename: string;
  createdAt: number;
  durationMs?: number;
  sizeBytes?: number;
}

// The CLI consumes this same source through @hyperframes/core's re-export.
// Importing from the browser-safe parsers package avoids the core barrel's
// Node-only transitive modules without duplicating the preset union in Studio.
export type ResolutionPreset = CanvasResolution;

export interface StartRenderOptions {
  fps?: ExportFrameRate;
  quality?: ExportQuality;
  format?: ExportFormat;
  /** `"auto"` (default) renders at the composition's authored dimensions. */
  resolution?: ResolutionPreset | "auto";
  /** Exact output dimensions. Mutually exclusive with `resolution`; capped at 8K. */
  dimensions?: ExportDimensions;
  /**
   * Render a specific composition file. Omit it to render the composition the
   * user currently has open — only the sidebar's per-composition Render button
   * names one, because it renders a card the user is not looking at.
   */
  composition?: string;
}

const RENDER_HEARTBEAT_INTERVAL_MS = 5_000;

function renderCancelUrl(jobId: string): string {
  return `/api/render/${encodeURIComponent(jobId)}/cancel`;
}

function renderHeartbeatUrl(jobId: string): string {
  return `/api/render/${encodeURIComponent(jobId)}/heartbeat`;
}

/**
 * Fire-and-forget shutdown path for page exit, component teardown and a lost
 * progress stream. The server-side lease remains the final backstop if neither
 * transport can leave a crashing tab.
 */
function bestEffortCancelRender(jobId: string): void {
  const url = renderCancelUrl(jobId);
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon?.(url)) return;
  } catch {
    // Fall through to keepalive fetch.
  }
  try {
    void fetch(url, { method: "POST", keepalive: true }).catch(() => undefined);
  } catch {
    // A closing document can reject before fetch returns a promise.
  }
}

// "Hide" (formerly "Clear") is a view operation, not a delete: hidden ids are
// remembered here so hidden renders don't resurrect from the on-disk history
// on the next load. Per-project key so projects don't hide each other's rows.
function hiddenIdsKey(projectId: string): string {
  return `hf-studio-hidden-renders:${projectId}`;
}

function readHiddenIds(projectId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(hiddenIdsKey(projectId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function writeHiddenIds(projectId: string, ids: Set<string>): void {
  try {
    // Cap the list so it doesn't grow unbounded across months of renders.
    window.localStorage.setItem(hiddenIdsKey(projectId), JSON.stringify([...ids].slice(-200)));
  } catch {
    /* localStorage may be unavailable or full */
  }
}

export function useRenderQueue(
  projectId: string | null,
  // A ref, not the value: the render target has to be read at click time, and
  // threading the value through would rebuild every callback below on each
  // composition switch.
  activeCompPathRef: { current: string | null },
) {
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  // History fetch failure — distinguished from "no renders yet" so the panel
  // never shows a false empty state.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Failure of a user action (delete/cancel), surfaced inline in the panel.
  const [actionError, setActionError] = useState<string | null>(null);
  // Owned here rather than in the panel: Studio renders from three places —
  // the panel's Export button, the header's, and each composition card in the
  // left sidebar — and a check living in one of them leaves the rest free to
  // start a render this machine cannot finish. Every caller routes through
  // `startRender`, so that is where the refusal belongs. Call sites still
  // read `ffmpegMissing` to put the prompt on screen, because a refusal the
  // user cannot see reads as a broken button.
  const { status: ffmpeg, checking: ffmpegChecking, recheck: recheckFfmpeg } = useFfmpegStatus();
  // A null status means the probe gave no answer (older server, failed
  // request), which is not evidence of a missing encoder. Unknown fails open.
  const ffmpegMissing = ffmpeg !== null && !ffmpeg.ok;
  // Each render owns its own transport. A single ref silently orphaned the
  // first FFmpeg process whenever the user started a second export.
  const eventSourcesRef = useRef(new Map<string, EventSource>());
  const activeJobIdsRef = useRef(new Set<string>());
  // React state cannot disable a button until the next render. This latch
  // closes the same-frame gap while the server is accepting the first POST.
  const pendingStartRef = useRef(false);
  // Renders started in THIS tab, mapped to the settings they ran with.
  // `loadRenders` also injects finished jobs from disk history, and those must
  // never trigger a feedback prompt — the user did not just watch them happen.
  const sessionJobs = useRef(new Map<string, FeedbackContext>());
  const promptedJobIds = useRef(new Set<string>());

  /**
   * The one way a render started here enters the list. Every start path — the
   * happy one and all three failure shortcuts — goes through here, so both
   * "this render belongs to this session" and "these are the settings it ran
   * with" have a single owner. A report about a render is only actionable if
   * it arrives with the settings that produced it.
   */
  const addSessionJob = useCallback((job: RenderJob, settings: FeedbackContext) => {
    sessionJobs.current.set(job.id, settings);
    setJobs((prev) => [...prev, job]);
  }, []);

  const closeEventSource = useCallback((jobId: string) => {
    eventSourcesRef.current.get(jobId)?.close();
    eventSourcesRef.current.delete(jobId);
    activeJobIdsRef.current.delete(jobId);
  }, []);

  const cancelAllActiveRenders = useCallback(() => {
    for (const jobId of activeJobIdsRef.current) bestEffortCancelRender(jobId);
    for (const source of eventSourcesRef.current.values()) source.close();
    eventSourcesRef.current.clear();
    activeJobIdsRef.current.clear();
  }, []);

  // Load completed renders from the server
  const loadRenders = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/renders`);
      if (!res.ok) {
        setLoadError(`Couldn't load render history (server error ${res.status}).`);
        return;
      }
      const data = await res.json();
      setLoadError(null);
      if (Array.isArray(data.renders)) {
        const hidden = readHiddenIds(projectId);
        setJobs((prev) => {
          const fromServer: RenderJob[] = data.renders
            .filter((r: { id: string }) => !hidden.has(r.id))
            .map(
              (r: {
                id: string;
                filename: string;
                createdAt: number;
                size: number;
                status?: string;
                durationMs?: number;
              }) => ({
                id: r.id,
                status: (r.status === "failed" ? "failed" : "complete") as "complete" | "failed",
                progress: 100,
                filename: r.filename,
                createdAt: r.createdAt,
                durationMs: r.durationMs,
                sizeBytes: r.size,
              }),
            );
          const remaining = new Map(fromServer.map((job) => [job.id, job]));
          const reconciled = prev.map((job) => {
            const persisted = remaining.get(job.id);
            if (!persisted) return job;
            remaining.delete(job.id);
            return { ...job, ...persisted };
          });
          return [...reconciled, ...remaining.values()];
        });
      }
    } catch {
      setLoadError("Couldn't load render history. Is the studio server running?");
    }
  }, [projectId]);

  useEffect(() => {
    loadRenders();
  }, [loadRenders]);

  // Start a render and track progress via SSE
  const startRender = useCallback(
    // fallow-ignore-next-line complexity
    async (opts: StartRenderOptions = {}) => {
      if (!projectId) return;
      if (pendingStartRef.current) return;
      // The server would answer this with a 503 anyway. Refusing here keeps
      // the reason and the fix in the message, and keeps a control that
      // forgot to disable itself from producing a mystery failure.
      if (ffmpegMissing) {
        addSessionJob(
          {
            id: generateId(),
            status: "failed",
            progress: 0,
            error: ffmpegInstallMessage(ffmpeg),
            filename: "Export blocked",
            createdAt: Date.now(),
          },
          {},
        );
        return;
      }

      const fps = opts.fps ?? 30;
      const quality = opts.quality ?? "standard";
      const format = opts.format ?? "mp4";
      const resolution = opts.resolution;
      const dimensions = opts.dimensions;
      let exportOptionError: string | null = null;
      if (!isExportFormat(format)) exportOptionError = "Unsupported export format.";
      else if (!isExportQuality(quality)) exportOptionError = "Unsupported export quality.";
      else if (!isExportFrameRate(fps)) exportOptionError = "Unsupported export frame rate.";
      else if (resolution && dimensions) {
        exportOptionError = "Choose either a resolution preset or exact dimensions, not both.";
      } else if (dimensions && !isValidExportOutputDimensions(dimensions)) {
        exportOptionError =
          "Export dimensions must be even whole pixels within the 8K limit.";
      }
      else if (
        resolution &&
        resolution !== "auto" &&
        !EXPORT_FORMAT_CAPABILITIES[format].supportsResolutionScaling
      ) {
        exportOptionError = `${EXPORT_FORMAT_CAPABILITIES[format].label} exports at native resolution.`;
      }
      if (exportOptionError) {
        addSessionJob(
          {
            id: generateId(),
            status: "failed",
            progress: 0,
            error: exportOptionError,
            filename: "Export blocked",
            createdAt: Date.now(),
          },
          {},
        );
        return;
      }
      // Which composition a render targets belongs here, with the same
      // argument the FFmpeg gate above makes: Studio starts renders from three
      // controls, and a default living in one of them leaves the others
      // exporting a file the user is not looking at. The header's Export
      // passed no options at all, so every render it started went to
      // index.html no matter which composition was selected (#3549).
      const composition = opts.composition ?? activeCompPathRef.current ?? undefined;

      trackStudioRenderStart({
        fps,
        quality,
        format,
        resolution: dimensions
          ? `${dimensions.width}x${dimensions.height}`
          : resolution,
        composition,
      });

      const startTime = Date.now();
      // Travels with any feedback about this render. Settings only: the
      // composition path is a name the user chose, not file contents.
      const settings: FeedbackContext = {
        render_format: format,
        render_quality: quality,
        render_fps: fps,
        render_resolution: dimensions
          ? `${dimensions.width}x${dimensions.height}`
          : resolution ?? "auto",
        render_composition: composition ?? "index.html",
      };
      // "auto" / undefined means "render at the composition's authored size".
      // Omit the field entirely — sending "auto" would trip the route's
      // enum validation set.
      const body: {
        fps: number;
        quality: string;
        format: string;
        resolution?: string;
        dimensions?: ExportDimensions;
        composition?: string;
        telemetryDistinctId?: string;
        telemetryOptOut?: boolean;
      } = {
        fps,
        quality,
        format,
      };
      // The id is MINTED by getAnonymousId(), so calling it unconditionally
      // created a telemetry identity for a profile that had opted out — and
      // then shipped it to the server. The server's own policy cannot see this
      // browser's localStorage or DoNotTrack, so it has to be told: an
      // explicit `telemetryOptOut` suppresses the render outcome, which
      // omitting the id alone does NOT (an old client omits it too, and that
      // falls back to the install id).
      if (browserTelemetryAllowed()) {
        // So the server-emitted render_complete/render_error is attributed to
        // this browser user (same id studio_* events use), making the render
        // funnel joinable. Matches studio_render_start fired just above.
        body.telemetryDistinctId = getAnonymousId();
      } else {
        body.telemetryOptOut = true;
      }
      if (resolution && resolution !== "auto") body.resolution = resolution;
      if (dimensions) body.dimensions = dimensions;
      if (composition) body.composition = composition;
      pendingStartRef.current = true;
      try {
        let res: Response;
        try {
          res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/render`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch (err) {
          // The cause used to be discarded. Every failure — a dead server, an
          // aborted request, a DNS error, a mid-render crash — surfaced as the
          // same sentence, and this string is what travels into the feedback
          // report too, so field reports of a render that fails *every time*
          // still carried nothing to act on. Preserve the underlying cause.
          const cause = err instanceof Error ? err.message : String(err);
          const failedJob: RenderJob = {
            id: generateId(),
            status: "failed",
            progress: 0,
            error: `Could not reach the local render service: ${cause}. Restart the editor and try again.`,
            filename: "Export failed",
            createdAt: startTime,
          };
          addSessionJob(failedJob, settings);
          return;
        }
        if (!res.ok) {
          const failedJob: RenderJob = {
            id: generateId(),
            status: "failed",
            progress: 0,
            error: await readServerError(res),
            filename: "Export failed",
            createdAt: startTime,
          };
          addSessionJob(failedJob, settings);
          return;
        }
        let jobId: string;
        try {
          const responseBody = (await res.json()) as { jobId?: unknown };
          if (typeof responseBody.jobId !== "string" || responseBody.jobId.length === 0) {
            throw new Error("missing job id");
          }
          jobId = responseBody.jobId;
        } catch (err) {
          const cause = err instanceof Error ? err.message : String(err);
          addSessionJob(
            {
              id: generateId(),
              status: "failed",
              progress: 0,
              error: `The local render service returned an invalid response: ${cause}`,
              filename: "Export failed",
              createdAt: startTime,
            },
            settings,
          );
          return;
        }

        const FORMAT_EXT: Record<string, string> = { mp4: ".mp4", webm: ".webm", mov: ".mov" };
        const ext = FORMAT_EXT[format] ?? ".mp4";
        const job: RenderJob = {
          id: jobId,
          status: "rendering",
          progress: 0,
          filename: `${jobId}${ext}`,
          createdAt: startTime,
        };
        addSessionJob(job, settings);
        activeJobIdsRef.current.add(jobId);

        // Track progress via SSE
        const es = new EventSource(`/api/render/${jobId}/progress`);
        eventSourcesRef.current.set(jobId, es);

        es.addEventListener("progress", (event) => {
          try {
            const data = JSON.parse(event.data);
            const terminal =
              data.status === "complete" || data.status === "failed" || data.status === "cancelled";
            setJobs((prev) =>
              prev.map((j) =>
                j.id === jobId
                  ? {
                      ...j,
                      progress: data.progress ?? j.progress,
                      stage: data.stage ?? data.message ?? j.stage,
                      status: terminal ? (data.status as RenderJob["status"]) : j.status,
                      durationMs: data.status === "complete" ? Date.now() - startTime : undefined,
                      error: data.error ?? j.error,
                    }
                  : j,
              ),
            );
            if (terminal) {
              closeEventSource(jobId);
              // The terminal progress event does not carry filesystem metadata.
              // Reconcile the same row with render history so its actual size
              // and persisted duration appear without requiring a remount.
              void loadRenders();
            }
          } catch {
            // ignore parse errors
          }
        });

        es.onerror = () => {
          // Losing the only progress channel must not leave FFmpeg burning in
          // the background. The lease also expires it if this request is lost.
          bestEffortCancelRender(jobId);
          closeEventSource(jobId);
          setJobs((prev) =>
            prev.map((j) =>
              j.id === jobId && j.status === "rendering"
                ? {
                    ...j,
                    status: "failed" as const,
                    error: "Connection lost. Is the render server running?",
                  }
                : j,
            ),
          );
        };

        return jobId;
      } finally {
        pendingStartRef.current = false;
      }
    },
    [
      projectId,
      activeCompPathRef,
      closeEventSource,
      addSessionJob,
      ffmpeg,
      ffmpegMissing,
      loadRenders,
    ],
  );

  // Cancel an in-flight render. Do not optimistically claim success: the row
  // and progress stream stay live until the route confirms the producer's
  // AbortSignal was fired.
  const cancelRender = useCallback(
    async (jobId: string) => {
      setActionError(null);
      try {
        const res = await fetch(renderCancelUrl(jobId), { method: "POST", keepalive: true });
        if (!res.ok) {
          setActionError("Couldn't cancel on the server — the render may still be running.");
          return;
        }
        const body = (await res.json().catch(() => null)) as { status?: string } | null;
        if (body?.status === "cancelled") {
          closeEventSource(jobId);
          setJobs((prev) =>
            prev.map((job) =>
              job.id === jobId && job.status === "rendering"
                ? { ...job, status: "cancelled" }
                : job,
            ),
          );
          return;
        }
        if (body?.status === "complete" || body?.status === "failed") {
          closeEventSource(jobId);
          setJobs((prev) =>
            prev.map((job) =>
              job.id === jobId ? { ...job, status: body.status as RenderJob["status"] } : job,
            ),
          );
          void loadRenders();
          return;
        }
        setActionError("The server did not confirm cancellation — the render may still be running.");
      } catch {
        setActionError("Couldn't reach the server to cancel — the render may still be running.");
      }
    },
    [closeEventSource, loadRenders],
  );

  const deleteRender = useCallback(
    async (jobId: string) => {
      setActionError(null);
      closeEventSource(jobId);
      try {
        const res = await fetch(`/api/render/${jobId}`, { method: "DELETE" });
        if (!res.ok) {
          setActionError("Couldn't delete the render — it's still on disk.");
          return;
        }
      } catch {
        setActionError("Couldn't reach the server to delete the render.");
        return;
      }
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
    },
    [closeEventSource],
  );

  // Hide finished rows from the list (view-only — files stay on disk and can
  // be recovered from the renders/ directory). Remembered per project so the
  // rows don't resurrect from history on reload.
  const clearCompleted = useCallback(() => {
    setJobs((prev) => {
      const finished = prev.filter((j) => j.status !== "rendering");
      if (projectId && finished.length > 0) {
        const hidden = readHiddenIds(projectId);
        for (const j of finished) hidden.add(j.id);
        writeHiddenIds(projectId, hidden);
      }
      return prev.filter((j) => j.status === "rendering");
    });
  }, [projectId]);

  const dismissActionError = useCallback(() => setActionError(null), []);

  // Ask for feedback the moment a render this tab started reaches its outcome.
  // Watching the list (rather than each of the four places a job can finish)
  // keeps one trigger for every path, including SSE drops and cancels-that-
  // finished-anyway. `requestStudioFeedback` decides whether to actually ask.
  useEffect(() => {
    for (const job of jobs) {
      if (job.status === "rendering" || job.status === "cancelled") continue;
      const settings = sessionJobs.current.get(job.id);
      if (!settings || promptedJobIds.current.has(job.id)) continue;
      promptedJobIds.current.add(job.id);
      requestStudioFeedback({
        reason: job.status === "complete" ? "render_complete" : "render_failed",
        renderId: job.id,
        detail: job.error,
        context: {
          ...settings,
          // How far it got and how long it took separate "died on frame one"
          // from "died during encode", which need different fixes.
          render_progress: job.progress,
          render_duration_ms: job.durationMs ?? Date.now() - job.createdAt,
          render_stage: job.stage,
          render_error: job.error,
          // Earlier renders this session: a first-render failure and a
          // failure after nine successes are different bugs.
          renders_this_session: sessionJobs.current.size,
        },
      });
    }
  }, [jobs]);

  // Heartbeats form a lease: a browser crash cannot run cleanup code, so the
  // server aborts FFmpeg after this tab stops renewing active jobs.
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const jobId of activeJobIdsRef.current) {
        void fetch(renderHeartbeatUrl(jobId), { method: "POST", keepalive: true }).catch(
          () => undefined,
        );
      }
    }, RENDER_HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  // A normal close gets an immediate cancellation attempt. A hard crash is
  // covered by the heartbeat lease above.
  useEffect(() => {
    const handleExit = () => cancelAllActiveRenders();
    window.addEventListener("pagehide", handleExit, { capture: true });
    window.addEventListener("beforeunload", handleExit, { capture: true });
    return () => {
      window.removeEventListener("pagehide", handleExit, { capture: true });
      window.removeEventListener("beforeunload", handleExit, { capture: true });
    };
  }, [cancelAllActiveRenders]);

  // Cancel active server work on unmount or projectId change, not merely its
  // EventSource observer.
  useEffect(() => {
    return cancelAllActiveRenders;
  }, [projectId, cancelAllActiveRenders]);

  const isRendering = jobs.some((j) => j.status === "rendering");
  return useMemo(
    () => ({
      jobs,
      isRendering,
      loadError,
      actionError,
      dismissActionError,
      reloadRenders: loadRenders,
      deleteRender,
      cancelRender,
      clearCompleted,
      startRender: startRender as (options: unknown) => Promise<void>,
      // Every Export control reads these, so no caller has to decide for
      // itself whether this machine can encode.
      ffmpeg,
      ffmpegMissing,
      ffmpegChecking,
      recheckFfmpeg,
    }),
    [
      jobs,
      isRendering,
      loadError,
      actionError,
      dismissActionError,
      loadRenders,
      deleteRender,
      cancelRender,
      clearCompleted,
      startRender,
      ffmpeg,
      ffmpegMissing,
      ffmpegChecking,
      recheckFfmpeg,
    ],
  );
}
