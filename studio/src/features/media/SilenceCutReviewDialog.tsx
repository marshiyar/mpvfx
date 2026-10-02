import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildSpeechSegments,
  DEFAULT_SILENCE_DETECTION_OPTIONS,
  type SilenceCutReviewDecision,
  type SilenceCutReviewMedia,
  type SpeechSegment,
} from "./detectSilence";
import { useDialogBehavior } from "../../ui/useDialogBehavior";

interface SilenceCutReviewDialogProps {
  media: readonly SilenceCutReviewMedia[] | null;
  onApply: (decision: SilenceCutReviewDecision) => void;
  onCancel: () => void;
}

const formatTime = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
};

export function SilenceCutReviewDialog({ media, onApply, onCancel }: SilenceCutReviewDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [minimumPauseSeconds, setMinimumPauseSeconds] = useState<number>(
    DEFAULT_SILENCE_DETECTION_OPTIONS.minimumPauseSeconds,
  );
  const [paddingSeconds, setPaddingSeconds] = useState<number>(
    DEFAULT_SILENCE_DETECTION_OPTIONS.paddingSeconds,
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLMediaElement>(null);
  const stopPreviewRef = useRef<(() => void) | null>(null);
  const open = Boolean(media?.length);
  const selected = media?.[selectedIndex] ?? null;
  const segments = selected
    ? buildSpeechSegments(selected.analysis, { minimumPauseSeconds, paddingSeconds })
    : [];
  const removedSeconds = selected
    ? Math.max(0, selected.analysis.duration - segments.reduce(
        (sum, segment) => sum + segment.sourceEnd - segment.sourceStart,
        0,
      ))
    : 0;

  useDialogBehavior({ open, onClose: onCancel, containerRef: dialogRef });

  useEffect(() => {
    setSelectedIndex(0);
    setMinimumPauseSeconds(DEFAULT_SILENCE_DETECTION_OPTIONS.minimumPauseSeconds);
    setPaddingSeconds(DEFAULT_SILENCE_DETECTION_OPTIONS.paddingSeconds);
  }, [media]);

  useEffect(() => {
    if (!selected) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selected.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selected]);

  useEffect(() => () => stopPreviewRef.current?.(), []);

  const previewSegment = useCallback((segment: SpeechSegment) => {
    const element = mediaRef.current;
    if (!element) return;
    stopPreviewRef.current?.();
    element.currentTime = segment.sourceStart;
    const stop = () => {
      if (element.currentTime < segment.sourceEnd) return;
      element.pause();
      element.removeEventListener("timeupdate", stop);
      stopPreviewRef.current = null;
    };
    stopPreviewRef.current = () => {
      element.pause();
      element.removeEventListener("timeupdate", stop);
    };
    element.addEventListener("timeupdate", stop);
    void element.play().catch(() => {
      element.removeEventListener("timeupdate", stop);
      stopPreviewRef.current = null;
    });
  }, []);

  if (!open || !selected) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="silence-review-title"
        tabIndex={-1}
        className="flex max-h-[min(90vh,760px)] w-full max-w-2xl flex-col overflow-hidden rounded-md border border-neutral-700 bg-neutral-950 text-neutral-100 shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-neutral-800 px-5 py-4">
          <div className="min-w-0">
            <h2 id="silence-review-title" className="text-base font-semibold">
              Review pause cuts
            </h2>
            <p className="mt-1 truncate text-xs text-neutral-400" title={selected.file.name}>
              {selected.file.name}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel import"
            title="Cancel import"
            className="flex h-8 w-8 flex-none items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-white"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {media!.length > 1 && (
          <div className="flex gap-1 overflow-x-auto border-b border-neutral-800 px-4 py-2">
            {media!.map((item, index) => (
              <button
                key={`${item.file.name}-${index}`}
                type="button"
                aria-pressed={selectedIndex === index}
                onClick={() => setSelectedIndex(index)}
                className={`max-w-56 truncate rounded px-2.5 py-1.5 text-xs ${
                  selectedIndex === index
                    ? "bg-neutral-700 text-white"
                    : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
                }`}
              >
                {item.file.name}
              </button>
            ))}
          </div>
        )}

        <div className="grid min-h-0 gap-4 overflow-y-auto p-5 md:grid-cols-[minmax(0,1.35fr)_minmax(220px,0.9fr)]">
          <div className="min-w-0 space-y-3">
            {previewUrl && selected.kind === "video" ? (
              <video
                key={previewUrl}
                ref={mediaRef as React.RefObject<HTMLVideoElement>}
                src={previewUrl}
                controls
                playsInline
                className="max-h-64 w-full rounded border border-neutral-800 bg-black"
              />
            ) : previewUrl ? (
              <audio
                key={previewUrl}
                ref={mediaRef as React.RefObject<HTMLAudioElement>}
                src={previewUrl}
                controls
                className="w-full"
              />
            ) : null}
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span>{segments.length} kept sections</span>
              <span>{removedSeconds.toFixed(2)}s removed</span>
            </div>
            <ol className="max-h-48 space-y-1 overflow-y-auto">
              {segments.map((segment, index) => (
                <li
                  key={`${segment.sourceStart}-${segment.sourceEnd}`}
                  className="flex items-center justify-between gap-2 rounded border border-neutral-800 px-3 py-2"
                >
                  <span className="min-w-0 truncate text-xs tabular-nums text-neutral-300">
                    {index + 1}. {formatTime(segment.sourceStart)}–{formatTime(segment.sourceEnd)}
                  </span>
                  <button
                    type="button"
                    onClick={() => previewSegment(segment)}
                    className="flex-none rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
                  >
                    Preview
                  </button>
                </li>
              ))}
            </ol>
          </div>

          <div className="space-y-4">
            <label className="block text-xs text-neutral-300">
              Minimum pause to cut (seconds)
              <input
                type="number"
                min="0.2"
                max="10"
                step="0.1"
                value={minimumPauseSeconds}
                onChange={(event) => setMinimumPauseSeconds(
                  Math.max(0.2, Math.min(10, Number(event.target.value) || 0.2)),
                )}
                className="mt-1.5 h-9 w-full rounded border border-neutral-700 bg-neutral-900 px-2 text-sm text-white"
              />
            </label>
            <label className="block text-xs text-neutral-300">
              Keep around speech (seconds)
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={paddingSeconds}
                onChange={(event) => setPaddingSeconds(
                  Math.max(0, Math.min(1, Number(event.target.value) || 0)),
                )}
                className="mt-1.5 h-9 w-full rounded border border-neutral-700 bg-neutral-900 px-2 text-sm text-white"
              />
            </label>
          </div>
        </div>

        <footer className="flex justify-end gap-2 border-t border-neutral-800 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-neutral-700 px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Cancel import
          </button>
          <button
            type="button"
            onClick={() => onApply({ minimumPauseSeconds, paddingSeconds })}
            className="rounded bg-studio-accent px-3 py-2 text-xs font-medium text-white hover:brightness-110"
          >
            Apply cuts
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}