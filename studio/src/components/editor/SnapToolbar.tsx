import { memo, useCallback, useEffect, useRef, useState } from "react";
import { MagnetStraight, GridFour } from "@phosphor-icons/react";
import { readStudioUiPreferences, writeStudioUiPreferences } from "../../utils/studioUiPreferences";

const SNAP_DEFAULTS = {
  snapEnabled: true,
  gridVisible: false,
  gridSpacing: 3,
  snapToGrid: false,
};

// fallow-ignore-next-line complexity
function readSnapPrefs() {
  const prefs = readStudioUiPreferences();
  return {
    snapEnabled: prefs.snapEnabled ?? SNAP_DEFAULTS.snapEnabled,
    gridVisible: prefs.gridVisible ?? SNAP_DEFAULTS.gridVisible,
    gridSpacing: [2, 3, 4].includes(prefs.gridSpacing ?? 0) ? prefs.gridSpacing! : 3,
    snapToGrid: prefs.snapToGrid ?? SNAP_DEFAULTS.snapToGrid,
  };
}

interface SnapToolbarProps {
  recordingState?: "idle" | "recording" | "preview";
  onToggleRecording?: () => void;
  onSnapChange?: (prefs: {
    snapEnabled: boolean;
    gridVisible: boolean;
    gridSpacing: number;
    snapToGrid: boolean;
  }) => void;
  crop?: {
    available: boolean;
    active: boolean;
    applying: boolean;
    onStart: () => void;
    onApply: () => void | Promise<unknown>;
    onCancel: () => void;
    onReset: () => void;
  };
}

// fallow-ignore-next-line complexity
export const SnapToolbar = memo(function SnapToolbar({ onSnapChange, crop, recordingState, onToggleRecording }: SnapToolbarProps) {
  const [prefs, setPrefs] = useState(readSnapPrefs);
  const [gridPopoverOpen, setGridPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const gridButtonRef = useRef<HTMLButtonElement>(null);

  const updatePrefs = useCallback(
    (patch: Partial<typeof prefs>) => {
      setPrefs((prev) => {
        const next = { ...prev, ...patch };
        writeStudioUiPreferences(patch);
        onSnapChange?.(next);
        return next;
      });
    },
    [onSnapChange],
  );

  const toggleSnap = useCallback(() => {
    updatePrefs({ snapEnabled: !prefs.snapEnabled });
  }, [prefs.snapEnabled, updatePrefs]);

  const toggleGrid = useCallback(() => {
    updatePrefs({ gridVisible: !prefs.gridVisible });
  }, [prefs.gridVisible, updatePrefs]);

  useEffect(() => {
    // fallow-ignore-next-line complexity
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (t instanceof HTMLElement && t.isContentEditable) return;
      if (t instanceof HTMLIFrameElement) return;
      if (e.key === "s" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        updatePrefs({ snapEnabled: !readSnapPrefs().snapEnabled });
      }
      if (e.key === "g" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        updatePrefs({ gridVisible: !readSnapPrefs().gridVisible });
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [updatePrefs]);

  useEffect(() => {
    if (!gridPopoverOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || gridButtonRef.current?.contains(target)) return;
      setGridPopoverOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [gridPopoverOpen]);

  return (
    <div
      role="toolbar"
      aria-label="Preview tools"
      className="absolute top-0 inset-x-0 z-50 flex h-9 items-center justify-end gap-1 border-b border-neutral-800/70 bg-neutral-950 px-2"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {onToggleRecording && (
        <button type="button" onClick={onToggleRecording}
          aria-label={recordingState === "recording" ? "Stop gesture recording" : "Record gesture (R)"}
          aria-pressed={recordingState === "recording"}
          title="Record movement (R)"
          className="mr-auto flex h-7 items-center gap-1.5 rounded px-2 text-[11px] text-neutral-300 hover:bg-neutral-800">
          <span className={`h-2 w-2 bg-red-500 ${recordingState === "recording" ? "rounded-sm animate-pulse" : "rounded-full"}`} />
          {recordingState === "recording" ? "Stop" : "Record"}
        </button>
      )}
      {crop?.available && !crop.active && !crop.applying && (
        <button
          type="button"
          className="rounded-md bg-black/40 px-2 py-1.5 text-[11px] font-medium text-white/70 transition-colors hover:bg-black/60 hover:text-white"
          onClick={crop.onStart}
          title="Crop selected media"
          aria-label="Start cropping"
        >
          Crop
        </button>
      )}
      {crop?.active && (
        <div
          data-preview-crop-toolbar="true"
          className="flex items-center gap-1 rounded-md border border-white/15 bg-black px-1 py-1"
          aria-label="Crop controls"
        >
          <button
            type="button"
            className="rounded px-2 py-1 text-[11px] text-white/65 hover:bg-neutral-900 hover:text-white disabled:opacity-40"
            onClick={crop.onReset}
            disabled={crop.applying}
            aria-label="Reset crop"
          >
            Reset
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 text-[11px] text-white/75 hover:bg-neutral-900 hover:text-white disabled:opacity-40"
            onClick={crop.onCancel}
            disabled={crop.applying}
            aria-label="Cancel crop"
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-studio-accent px-2 py-1 text-[11px] font-semibold text-black disabled:opacity-40"
            onClick={() => void crop.onApply()}
            disabled={crop.applying}
            aria-label="Apply crop"
          >
            {crop.applying ? "Applying…" : "Apply"}
          </button>
        </div>
      )}
      <button
        type="button"
        className={`rounded-md p-1.5 transition-colors active:scale-[0.95] ${
          prefs.snapEnabled
            ? "bg-studio-accent/20 text-studio-accent"
            : "bg-black/40 text-white/60 hover:bg-black/60 hover:text-white/80"
        }`}
        onClick={toggleSnap}
        title={prefs.snapEnabled ? "Snap enabled (S)" : "Snap disabled (S)"}
        aria-label="Toggle snap"
      >
        <MagnetStraight size={16} weight={prefs.snapEnabled ? "fill" : "regular"} />
      </button>

      <div className="relative">
        <button
          ref={gridButtonRef}
          type="button"
          className={`rounded-md p-1.5 transition-colors active:scale-[0.95] ${
            prefs.gridVisible
              ? "bg-studio-accent/20 text-studio-accent"
              : "bg-black/40 text-white/60 hover:bg-black/60 hover:text-white/80"
          }`}
          onClick={toggleGrid}
          onContextMenu={(e) => {
            e.preventDefault();
            setGridPopoverOpen((v) => !v);
          }}
          title={
            prefs.gridVisible
              ? "Grid visible (G)"
              : "Grid hidden (G)"
          }
          aria-label="Toggle grid"
        >
          <GridFour size={16} weight={prefs.gridVisible ? "fill" : "regular"} />
        </button>
        <button
          type="button"
          className="absolute -right-0.5 -bottom-0.5 rounded p-0.5 text-white/50 hover:text-white/90 bg-black/50"
          onClick={() => setGridPopoverOpen((v) => !v)}
          title="Grid options"
          aria-label="Grid options"
          aria-expanded={gridPopoverOpen}
        >
          <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true">
            <path d="M1 2.5l3 3 3-3z" />
          </svg>
        </button>

        {gridPopoverOpen && (
          <div
            ref={popoverRef}
            className="absolute right-0 top-full mt-1 rounded-lg bg-neutral-800 border border-neutral-700 p-3 min-w-[180px]"
          >
            <div className="flex gap-1" aria-label="Grid preset">
              {[{ value: 3, label: "Thirds" }, { value: 4, label: "Quarters" }, { value: 2, label: "Center" }].map(preset => (
                <button key={preset.value} type="button" aria-pressed={prefs.gridSpacing === preset.value}
                  className={`rounded px-2 py-1.5 text-[11px] ${prefs.gridSpacing === preset.value ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/5"}`}
                  onClick={() => { updatePrefs({ gridSpacing: preset.value, gridVisible: true }); setGridPopoverOpen(false); }}>
                  {preset.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-white/80 cursor-pointer">
              <input
                type="checkbox"
                checked={prefs.snapToGrid}
                onChange={() => updatePrefs({ snapToGrid: !prefs.snapToGrid })}
                className="accent-studio-accent"
              />
              <span>Snap to grid</span>
            </label>
          </div>
        )}
      </div>
    </div>
  );
});
