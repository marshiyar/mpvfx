import { useEffect, useId, useState } from "react";
import type {
  CubicBezierControlPoints,
  NativeInterpolation,
} from "../../project/nativeKeyframeTypes";

export interface NativeInterpolationEditorProps {
  readonly value: NativeInterpolation;
  readonly disabled?: boolean;
  readonly onCommit: (value: NativeInterpolation) => void;
}

const DEFAULT_CUBIC: CubicBezierControlPoints = {
  x1: 0.33,
  y1: 0,
  x2: 0.67,
  y2: 1,
};

// Cubic timing requires monotonic X handles. Y is deliberately bounded to keep
// overshoot useful and editable without allowing impractical curve values.
export const NATIVE_CUBIC_Y_MIN = -1;
export const NATIVE_CUBIC_Y_MAX = 2;

type ControlName = keyof CubicBezierControlPoints;

const CONTROL_NAMES = ["x1", "y1", "x2", "y2"] as const satisfies readonly ControlName[];

const clonePoints = (points: CubicBezierControlPoints): CubicBezierControlPoints => ({
  x1: points.x1,
  y1: points.y1,
  x2: points.x2,
  y2: points.y2,
});

const pointsForValue = (value: NativeInterpolation): CubicBezierControlPoints =>
  value.type === "cubic-bezier" ? clonePoints(value.controlPoints) : clonePoints(DEFAULT_CUBIC);

const pointDrafts = (points: CubicBezierControlPoints): Record<ControlName, string> => ({
  x1: String(points.x1),
  y1: String(points.y1),
  x2: String(points.x2),
  y2: String(points.y2),
});

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const normalizeControl = (name: ControlName, value: number): number =>
  name === "x1" || name === "x2"
    ? clamp(value, 0, 1)
    : clamp(value, NATIVE_CUBIC_Y_MIN, NATIVE_CUBIC_Y_MAX);

export function NativeInterpolationEditor({
  value,
  disabled = false,
  onCommit,
}: NativeInterpolationEditorProps) {
  const initialPoints = pointsForValue(value);
  const [points, setPoints] = useState<CubicBezierControlPoints>(initialPoints);
  const [drafts, setDrafts] = useState<Record<ControlName, string>>(() =>
    pointDrafts(initialPoints),
  );
  const [invalidControl, setInvalidControl] = useState<ControlName | null>(null);
  const errorId = useId();

  const sourcePoints = value.type === "cubic-bezier" ? value.controlPoints : DEFAULT_CUBIC;
  useEffect(() => {
    const next = clonePoints(sourcePoints);
    setPoints(next);
    setDrafts(pointDrafts(next));
    setInvalidControl(null);
  }, [sourcePoints.x1, sourcePoints.y1, sourcePoints.x2, sourcePoints.y2, value.type]);

  const commitControl = (name: ControlName): void => {
    const raw = drafts[name].trim();
    const parsed = raw === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(parsed)) {
      setDrafts((current) => ({ ...current, [name]: String(points[name]) }));
      setInvalidControl(name);
      return;
    }

    const normalized = normalizeControl(name, parsed);
    const nextPoints = { ...points, [name]: normalized };
    setPoints(nextPoints);
    setDrafts((current) => ({ ...current, [name]: String(normalized) }));
    setInvalidControl(null);
    onCommit({ type: "cubic-bezier", controlPoints: nextPoints });
  };

  const commitType = (type: NativeInterpolation["type"]): void => {
    if (type === "cubic-bezier") {
      onCommit({ type, controlPoints: clonePoints(points) });
      return;
    }
    onCommit({ type });
  };

  return (
    <div className="space-y-2">
      <div
        role="group"
        aria-label="Interpolation"
        className="grid grid-cols-3 gap-1 rounded-md bg-black/20 p-1"
      >
        {(
          [
            ["hold", "Hold"],
            ["linear", "Linear"],
            ["cubic-bezier", "Cubic"],
          ] as const
        ).map(([type, label]) => {
          const selected = value.type === type;
          return (
            <button
              key={type}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => commitType(type)}
              className={`rounded px-2 py-1 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                selected
                  ? "bg-panel-accent/20 text-panel-accent"
                  : "text-panel-text-3 hover:bg-white/5 hover:text-panel-text-1"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {value.type === "cubic-bezier" && (
        <div className="space-y-1.5">
          <div className="grid grid-cols-4 gap-1.5">
            {CONTROL_NAMES.map((name) => {
              const upperName = name.toUpperCase();
              const label = `Cubic ${upperName}`;
              return (
                <label key={name} className="min-w-0 text-[9px] text-panel-text-3">
                  <span className="mb-0.5 block">{upperName}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label={label}
                    aria-invalid={invalidControl === name}
                    aria-describedby={invalidControl === name ? errorId : undefined}
                    value={drafts[name]}
                    disabled={disabled}
                    onChange={(event) => {
                      const nextDraft = event.currentTarget.value;
                      setDrafts((current) => ({ ...current, [name]: nextDraft }));
                      if (invalidControl === name) setInvalidControl(null);
                    }}
                    onBlur={() => commitControl(name)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    className={`w-full rounded border bg-black/20 px-1.5 py-1 font-mono text-[10px] text-panel-text-1 outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
                      invalidControl === name
                        ? "border-red-500/70 focus:border-red-400"
                        : "border-white/10 focus:border-panel-accent/50"
                    }`}
                  />
                </label>
              );
            })}
          </div>
          <p className="text-[9px] text-panel-text-3">X handles: 0–1. Y handles: −1–2.</p>
          <p
            id={errorId}
            aria-live="polite"
            className={`text-[9px] text-red-400 ${invalidControl === null ? "sr-only" : ""}`}
          >
            {invalidControl === null ? "Cubic handles are valid" : "Enter a finite number"}
          </p>
        </div>
      )}
    </div>
  );
}
