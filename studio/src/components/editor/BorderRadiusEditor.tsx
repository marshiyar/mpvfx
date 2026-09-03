import { useCallback, useState } from "react";
import { useTrackDesignInput } from "../../contexts/DesignPanelInputContext";
import { RotateCcw } from "../../icons/SystemIcons";
import { MetricField } from "./propertyPanelPrimitives";
import { formatNumericValue, parseNumericValue, RESPONSIVE_GRID } from "./propertyPanelHelpers";

type Corner = "tl" | "tr" | "br" | "bl";

interface BorderRadiusEditorProps {
  tl: number;
  tr: number;
  br: number;
  bl: number;
  disabled?: boolean;
  onCommit: (corner: Corner | "all", value: number) => void;
}

const PREVIEW_W = 72;
const PREVIEW_H = 52;
const MAX_RADIUS = 26;

function clampRadius(v: number): number {
  return Math.max(0, Math.min(MAX_RADIUS, v));
}

function scaleRadius(v: number, maxPx: number): number {
  if (maxPx <= 0) return 0;
  return clampRadius(Math.round((v / Math.max(maxPx, 1)) * MAX_RADIUS));
}

export function BorderRadiusEditor({
  tl,
  tr,
  br,
  bl,
  disabled,
  onCommit,
}: BorderRadiusEditorProps) {
  const track = useTrackDesignInput();
  const uniform = tl === tr && tr === br && br === bl;
  const [linked, setLinked] = useState(uniform);

  const maxVal = Math.max(tl, tr, br, bl, 1);
  const sTL = scaleRadius(tl, maxVal);
  const sTR = scaleRadius(tr, maxVal);
  const sBR = scaleRadius(br, maxVal);
  const sBL = scaleRadius(bl, maxVal);

  const handleCornerCommit = useCallback(
    (corner: Corner, raw: string) => {
      const v = parseNumericValue(raw) ?? 0;
      if (linked) {
        onCommit("all", v);
      } else {
        onCommit(corner, v);
      }
    },
    [linked, onCommit],
  );

  const handleToggleLinked = useCallback(() => {
    if (!linked && !uniform) {
      onCommit("all", tl);
    }
    setLinked((l) => !l);
  }, [linked, uniform, tl, onCommit]);

  const path = buildRoundedRectPath(PREVIEW_W, PREVIEW_H, sTL, sTR, sBR, sBL);

  const radiusField = (label: string, corner: Corner | "all", value: number) => (
    <div className="group relative min-w-0">
      <MetricField
        label={label}
        value={formatNumericValue(value)}
        disabled={disabled}
        liveCommit
        onCommit={(next) =>
          corner === "all" ? handleCornerCommit("tl", next) : handleCornerCommit(corner, next)
        }
      />
      {value !== 0 && (
        <button
          type="button"
          aria-label={`Reset ${label} radius`}
          title={`Reset ${label} radius`}
          disabled={disabled}
          onClick={() => {
            track("button", `Reset ${label} radius`);
            onCommit(corner, 0);
          }}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-panel-text-3 opacity-0 transition-opacity hover:text-panel-text-1 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RotateCcw size={10} />
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <svg
          width={PREVIEW_W}
          height={PREVIEW_H}
          viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
          className="flex-shrink-0"
        >
          <path
            d={path}
            fill="rgba(255,255,255,0.06)"
            stroke="rgba(255,255,255,0.24)"
            strokeWidth={1.5}
          />
          <circle cx={sTL} cy={sTL} r={3} fill={linked ? "#3b82f6" : "#a78bfa"} />
          <circle cx={PREVIEW_W - sTR} cy={sTR} r={3} fill={linked ? "#3b82f6" : "#a78bfa"} />
          <circle
            cx={PREVIEW_W - sBR}
            cy={PREVIEW_H - sBR}
            r={3}
            fill={linked ? "#3b82f6" : "#a78bfa"}
          />
          <circle cx={sBL} cy={PREVIEW_H - sBL} r={3} fill={linked ? "#3b82f6" : "#a78bfa"} />
        </svg>

        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-300"
          onClick={handleToggleLinked}
          disabled={disabled}
          title={linked ? "Unlink corners" : "Link all corners"}
        >
          {linked ? (
            <svg
              width={14}
              height={14}
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path d="M6 12H4a4 4 0 010-8h2M10 4h2a4 4 0 010 8h-2M5 8h6" />
            </svg>
          ) : (
            <svg
              width={14}
              height={14}
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path d="M6 12H4a4 4 0 010-8h2M10 4h2a4 4 0 010 8h-2" />
            </svg>
          )}
        </button>
      </div>

      {linked ? (
        radiusField("All", "all", tl)
      ) : (
        <div className={RESPONSIVE_GRID}>
          {radiusField("TL", "tl", tl)}
          {radiusField("TR", "tr", tr)}
          {radiusField("BL", "bl", bl)}
          {radiusField("BR", "br", br)}
        </div>
      )}
    </div>
  );
}

function buildRoundedRectPath(
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number,
): string {
  return [
    `M ${tl} 0`,
    `L ${w - tr} 0`,
    `Q ${w} 0 ${w} ${tr}`,
    `L ${w} ${h - br}`,
    `Q ${w} ${h} ${w - br} ${h}`,
    `L ${bl} ${h}`,
    `Q 0 ${h} 0 ${h - bl}`,
    `L 0 ${tl}`,
    `Q 0 0 ${tl} 0`,
    "Z",
  ].join(" ");
}
