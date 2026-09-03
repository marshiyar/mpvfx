import { memo, useState, useRef, useEffect, useLayoutEffect, useId } from "react";
import { createPortal } from "react-dom";
import { RenderQueueItem } from "./RenderQueueItem";
import { FfmpegRequiredNotice } from "./FfmpegRequiredNotice";
import type { FfmpegStatus } from "./useFfmpegStatus";
import { Button } from "../ui/Button";
import { resolveFloatingPanelPosition, type FloatingPosition } from "../editor/floatingPanel";
import type { RenderJob } from "./useRenderQueue";
import {
  getPersistedRenderSettings,
  persistRenderSettings,
  resolvePersistedRenderResolution,
} from "./renderSettings";
import { trackStudioEvent } from "../../utils/studioTelemetry";
import {
  exportAspectRatioLabel,
  EXPORT_RESOLUTION_PRESETS,
  isValidExportDimensions,
  isValidExportOutputDimensions,
  resolveExportTargetDimensions,
  type ExportDimensions,
  type ExportFormat,
  type ExportFrameRate,
  type ExportQuality,
  type ExportResolutionChoice,
} from "../../utils/exportPolicy";

export interface CompositionDimensions {
  width: number;
  height: number;
}

type StartRenderHandler = (
  format: ExportFormat,
  quality: ExportQuality,
  resolution: "auto" | ExportDimensions,
  fps: ExportFrameRate,
) => void | Promise<void>;

interface RenderQueueProps {
  jobs: RenderJob[];
  projectId: string;
  onDelete: (jobId: string) => void;
  onCancel?: (jobId: string) => void;
  onClearCompleted: () => void;
  onStartRender: StartRenderHandler;
  isRendering: boolean;
  /** History fetch failure (null when the last load succeeded). */
  loadError?: string | null;
  /** Retry a failed history load. */
  onRetryLoad?: () => void;
  /** Failure of a delete/cancel action, shown inline until dismissed. */
  actionError?: string | null;
  onDismissActionError?: () => void;
  /**
   * Authored dimensions of the active composition. Used to pick the
   * matching preset (landscape / portrait / square) when the user selects
   * a 1080p or 4K scale. `null` falls back to landscape (legacy default).
   */
  compositionDimensions?: CompositionDimensions | null;
  /**
   * Encoder availability, owned by useRenderQueue so the panel's Export button
   * and the header's agree. `null` means "no answer", not "missing".
   */
  ffmpeg: FfmpegStatus | null;
  ffmpegChecking: boolean;
  onRecheckFfmpeg: () => void;
}

type RenderScale = ExportResolutionChoice;
const RESOLUTION_GROUPS = [
  "Landscape",
  "Portrait",
  "Square",
  "Social",
  "Classic & Cinema",
] as const;

const FORMAT_INFO: Record<"mp4" | "webm" | "mov", { label: string; desc: string }> = {
  mp4: {
    label: "MP4",
    desc: "Best for general use. Broad playback compatibility with efficient compression.",
  },
  mov: {
    label: "MOV (ProRes 4444)",
    desc: "Transparent video. Works in Final Cut Pro, DaVinci Resolve, and most video editors. Large files.",
  },
  webm: {
    label: "WebM (VP9)",
    desc: "Transparent video for web. Smaller than MOV but limited editor support.",
  },
};

// Estimated, like COLOR_PICKER_SIZE in propertyPanelColor: only the flip
// decision uses the height, and the clamp keeps the panel on screen either way.
const FORMAT_PANEL_SIZE = { width: 208, height: 150 };

// Rich format guidance in a keyboard-reachable disclosure: the trigger is a
// real button (focusable, labelled), the panel is tied to it via
// aria-describedby, and Escape dismisses (WCAG 1.4.13). Content is too rich
// for the one-line ui/Tooltip primitive, so this stays a local popover.
// It renders in a portal because the right panel is overflow-hidden: an
// in-flow absolute panel gets clipped at the panel edge.
function FormatInfoTooltip({ format }: { format: "mp4" | "webm" | "mov" }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<FloatingPosition | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const panelId = useId();

  const show = () => {
    clearTimeout(timeoutRef.current);
    setOpen(true);
  };
  const hide = () => {
    timeoutRef.current = setTimeout(() => setOpen(false), 120);
  };

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  // Positioned once on open, so it does not follow panel scroll. The popover
  // is hover-lived; add a scroll listener only if that ever shows up.
  useLayoutEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    setPosition(
      resolveFloatingPanelPosition(
        el.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        FORMAT_PANEL_SIZE,
        { offset: 6 },
      ),
    );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const info = FORMAT_INFO[format];

  return (
    <div ref={triggerRef} className="relative" onPointerEnter={show} onPointerLeave={hide}>
      <button
        type="button"
        aria-label="About video formats"
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        onFocus={show}
        onBlur={hide}
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center justify-center p-0.5 -m-0.5 rounded text-panel-text-5 hover:text-panel-text-3 transition-colors cursor-help outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-studio-accent"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            id={panelId}
            role="tooltip"
            onPointerEnter={show}
            onPointerLeave={hide}
            className="fixed w-52 p-2 rounded bg-panel-input border border-neutral-700 z-[200]"
            style={{ left: position?.left ?? -9999, top: position?.top ?? -9999 }}
          >
            <p className="text-[10px] font-semibold text-panel-text-1 mb-0.5">{info.label}</p>
            <p className="text-[9px] text-panel-text-3 leading-tight">{info.desc}</p>
            <div className="mt-1.5 pt-1.5 border-t border-neutral-800">
              {(["mp4", "mov", "webm"] as const)
                .filter((f) => f !== format)
                .map((f) => (
                  <p key={f} className="text-[9px] text-panel-text-4 leading-relaxed">
                    <span className="text-panel-text-3 font-medium">{FORMAT_INFO[f].label}</span>
                    {" — "}
                    {FORMAT_INFO[f].desc}
                  </p>
                ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

const QUALITY_OPTIONS: {
  value: "draft" | "standard" | "high";
  label: string;
  title: string;
}[] = [
  { value: "draft", label: "Draft", title: "Fast render, smaller file" },
  { value: "standard", label: "Standard", title: "Good quality, balanced file size" },
  { value: "high", label: "High Quality", title: "Best quality, larger file" },
];

function formatEta(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function FormatExportButton({
  onStartRender,
  isRendering,
  compositionDimensions,
  lastRenderDurationMs,
  ffmpeg,
  ffmpegChecking,
  onRecheckFfmpeg,
}: {
  onStartRender: StartRenderHandler;
  isRendering: boolean;
  compositionDimensions?: CompositionDimensions | null;
  lastRenderDurationMs?: number;
  ffmpeg: FfmpegStatus | null;
  ffmpegChecking: boolean;
  onRecheckFfmpeg: () => void;
}) {
  const persisted = getPersistedRenderSettings();
  const [format, setFormat] = useState<ExportFormat>(persisted.format);
  const [quality, setQuality] = useState<ExportQuality>(persisted.quality);
  // Keep legacy 1080p/4K as aspect-relative choices in storage. The displayed
  // fixed preset is derived per active canvas and is never written globally.
  const [resolution, setResolution] = useState<RenderScale>(persisted.resolution);
  const [customWidth, setCustomWidth] = useState(
    String(persisted.customDimensions?.width ?? compositionDimensions?.width ?? 1920),
  );
  const [customHeight, setCustomHeight] = useState(
    String(persisted.customDimensions?.height ?? compositionDimensions?.height ?? 1080),
  );
  const [fps, setFps] = useState<ExportFrameRate>(persisted.fps);

  // Only a definite "not installed" blocks Export. A null status means the
  // probe gave no answer, and refusing to export on no answer would break
  // setups that are perfectly fine. Holding the narrowed value rather than a
  // boolean keeps the notice from re-testing what this line already decided.
  const missingFfmpeg = ffmpeg && !ffmpeg.ok ? ffmpeg : null;

  // MOV (ProRes) is a fixed-quality codec — quality selector has no effect.
  const showQuality = format !== "mov";
  const parsedCustomDimensions = {
    width: Number(customWidth),
    height: Number(customHeight),
  };
  const selectedResolution = resolvePersistedRenderResolution(
    resolution,
    compositionDimensions,
  );
  const selectedOutputDimensions = resolveExportTargetDimensions(
    selectedResolution,
    compositionDimensions,
    parsedCustomDimensions,
  );
  const waitingForLegacyCanvas =
    (selectedResolution === "1080p" || selectedResolution === "4k") && !compositionDimensions;
  const validation = selectedOutputDimensions
    ? { ok: true, issues: [] }
    : {
        ok: false,
        issues: [
          waitingForLegacyCanvas
            ? "Waiting for the canvas dimensions before restoring the saved export size."
            : selectedResolution === "custom"
            ? "Custom dimensions must be even whole pixels within the 8K limit (7680 long edge, 4320 short edge)."
            : "Canvas dimensions exceed the 8K export limit (7680 long edge, 4320 short edge).",
        ],
      };
  const compatibilityIssue = validation.issues[0];

  const selectCls =
    "h-7 w-full px-2 text-[11px] bg-panel-input rounded-md text-panel-text-1 outline-none cursor-pointer disabled:opacity-50 hover:bg-panel-hover transition-colors";

  return (
    <div className="flex flex-col gap-3">
      {missingFfmpeg && (
        <FfmpegRequiredNotice
          status={missingFfmpeg}
          checking={ffmpegChecking}
          onRecheck={onRecheckFfmpeg}
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-panel-text-4">Format</span>
            <FormatInfoTooltip format={format} />
          </div>
          <select
            value={format}
            onChange={(e) => {
              const v = e.target.value as ExportFormat;
              setFormat(v);
              persistRenderSettings(
                v,
                quality,
                fps,
                resolution,
                parsedCustomDimensions,
              );
            }}
            disabled={isRendering}
            className={selectCls}
          >
            <option value="mp4">MP4</option>
            <option value="mov">MOV (ProRes)</option>
            <option value="webm">WebM</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-panel-text-4">Resolution</span>
          <select
            value={selectedResolution}
            onChange={(e) => {
              const v = e.target.value as RenderScale;
              setResolution(v);
              persistRenderSettings(format, quality, fps, v, parsedCustomDimensions);
            }}
            disabled={isRendering}
            className={selectCls}
          >
            <option value="auto">
              Auto{compositionDimensions
                ? ` · ${compositionDimensions.width}×${compositionDimensions.height} · ${exportAspectRatioLabel(compositionDimensions)}`
                : " · Canvas size"}
            </option>
            {(selectedResolution === "1080p" || selectedResolution === "4k") && (
              <option value={selectedResolution} hidden>
                Restoring saved {selectedResolution === "4k" ? "4K" : "1080p"} size…
              </option>
            )}
            {RESOLUTION_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {Object.entries(EXPORT_RESOLUTION_PRESETS)
                  .filter(([, preset]) => preset.group === group)
                  .map(([value, preset]) => (
                    <option key={value} value={value}>
                      {preset.label} · {preset.width}×{preset.height} · {preset.ratio}
                    </option>
                  ))}
              </optgroup>
            ))}
            <option value="custom">Custom dimensions…</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-panel-text-4">Frame rate</span>
          <select
            value={fps}
            onChange={(e) => {
              const v = Number(e.target.value) as ExportFrameRate;
              setFps(v);
              persistRenderSettings(format, quality, v, resolution, parsedCustomDimensions);
            }}
            disabled={isRendering}
            className={selectCls}
          >
            <option value={24}>24 fps</option>
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </div>
        {showQuality && (
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-panel-text-4">Quality</span>
            <select
              value={quality}
              onChange={(e) => {
                const v = e.target.value as ExportQuality;
                setQuality(v);
                persistRenderSettings(format, v, fps, resolution, parsedCustomDimensions);
              }}
              disabled={isRendering}
              className={selectCls}
            >
              {QUALITY_OPTIONS.map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {selectedResolution === "custom" && (
        <div className="grid grid-cols-2 gap-2 rounded-md border border-panel-border bg-panel-input/40 p-2">
          <label className="flex flex-col gap-1 text-[10px] text-panel-text-4">
            Width
            <input
              aria-label="Custom export width"
              type="number"
              inputMode="numeric"
              min={2}
              max={7680}
              step={2}
              value={customWidth}
              onChange={(event) => {
                const width = event.target.value;
                setCustomWidth(width);
                persistRenderSettings(format, quality, fps, resolution, {
                  width: Number(width),
                  height: Number(customHeight),
                });
              }}
              disabled={isRendering}
              className={selectCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] text-panel-text-4">
            Height
            <input
              aria-label="Custom export height"
              type="number"
              inputMode="numeric"
              min={2}
              max={7680}
              step={2}
              value={customHeight}
              onChange={(event) => {
                const height = event.target.value;
                setCustomHeight(height);
                persistRenderSettings(format, quality, fps, resolution, {
                  width: Number(customWidth),
                  height: Number(height),
                });
              }}
              disabled={isRendering}
              className={selectCls}
            />
          </label>
          <p className="col-span-2 text-[9px] text-panel-text-4">
            Ratio {isValidExportDimensions(parsedCustomDimensions)
              ? exportAspectRatioLabel(parsedCustomDimensions)
              : "—"}. Maximum 8K; aspect changes fit and pad without stretching.
          </p>
        </div>
      )}
      <Button
        variant="primary"
        size="md"
        loading={isRendering}
        disabled={missingFfmpeg !== null || !validation.ok}
        title={
          missingFfmpeg
            ? "MpVFX's bundled media tools are unavailable. Reinstall the application."
            : compatibilityIssue
              ? compatibilityIssue
              : undefined
        }
        onClick={() => {
          // loading already disables the button; this guard also stops a
          // double-click in the same frame from enqueueing two renders.
          if (isRendering || missingFfmpeg) return;
          if (!validation.ok) return;
          if (selectedResolution === "auto") {
            trackStudioEvent("render_start", {
              format,
              quality,
              resolution: "auto",
              fps,
            });
            void onStartRender(format, quality, "auto", fps);
            return;
          }
          if (!selectedOutputDimensions || !isValidExportOutputDimensions(selectedOutputDimensions)) {
            return;
          }
          trackStudioEvent("render_start", {
            format,
            quality,
            resolution: `${selectedOutputDimensions.width}x${selectedOutputDimensions.height}`,
            fps,
          });
          void onStartRender(format, quality, selectedOutputDimensions, fps);
        }}
        className="w-full text-[11px] font-semibold"
      >
        {isRendering ? "Rendering…" : "Export"}
      </Button>
      {compatibilityIssue && (
        <p role="alert" className="text-[9px] text-red-400 text-center -mt-1.5">
          {compatibilityIssue}
        </p>
      )}
      {lastRenderDurationMs !== undefined && !isRendering && (
        <p className="text-[9px] text-panel-text-5 text-center -mt-1.5">
          Last render took {formatEta(lastRenderDurationMs)}
        </p>
      )}
    </div>
  );
}

export const RenderQueue = memo(function RenderQueue({
  jobs,
  projectId,
  onDelete,
  onCancel,
  onClearCompleted,
  onStartRender,
  isRendering,
  loadError,
  onRetryLoad,
  actionError,
  onDismissActionError,
  compositionDimensions,
  ffmpeg,
  ffmpegChecking,
  onRecheckFfmpeg,
}: RenderQueueProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new jobs are added.
  // Runs in an effect to avoid side effects during the render phase.
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [jobs.length]);

  const completedCount = jobs.filter((j) => j.status !== "rendering").length;
  const lastRenderDurationMs = [...jobs]
    .reverse()
    .find((j) => j.status === "complete" && j.durationMs !== undefined)?.durationMs;

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-3 border-b border-panel-border flex-shrink-0">
        <FormatExportButton
          onStartRender={onStartRender}
          isRendering={isRendering}
          compositionDimensions={compositionDimensions}
          lastRenderDurationMs={lastRenderDurationMs}
          ffmpeg={ffmpeg}
          ffmpegChecking={ffmpegChecking}
          onRecheckFfmpeg={onRecheckFfmpeg}
        />
      </div>

      {actionError && (
        <div
          role="alert"
          className="flex items-start justify-between gap-2 px-3 py-2 border-b border-panel-border bg-red-500/10"
        >
          <span className="text-[10px] text-red-400">{actionError}</span>
          {onDismissActionError && (
            <button
              onClick={onDismissActionError}
              aria-label="Dismiss error"
              className="text-[10px] text-panel-text-4 hover:text-panel-text-2 flex-shrink-0"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {/* Job list */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {loadError && jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-4 gap-2" role="alert">
            <p className="text-[10px] text-red-400 text-center">{loadError}</p>
            {onRetryLoad && (
              <Button size="sm" variant="secondary" onClick={onRetryLoad}>
                Retry
              </Button>
            )}
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-4 gap-2">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-panel-text-5"
            >
              <rect
                x="2"
                y="2"
                width="20"
                height="20"
                rx="2.18"
                ry="2.18"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <p className="text-[10px] text-panel-text-5 text-center">No renders yet</p>
          </div>
        ) : (
          <div>
            {completedCount > 0 && (
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-panel-border">
                <span className="text-[10px] text-panel-text-4">
                  {jobs.length} render{jobs.length === 1 ? "" : "s"}
                </span>
                {/* "Hide", not "Clear": files stay on disk (delete is per-row
                    and confirmed); hidden rows don't resurrect on reload. */}
                <button
                  onClick={onClearCompleted}
                  title="Hide finished renders from this list (files stay on disk)"
                  className="text-[10px] text-panel-text-4 hover:text-panel-text-2 transition-colors"
                >
                  Hide finished
                </button>
              </div>
            )}
            {jobs.map((job) => (
              <RenderQueueItem
                key={job.id}
                job={job}
                projectId={projectId}
                onDelete={() => onDelete(job.id)}
                onCancel={() => onCancel?.(job.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
