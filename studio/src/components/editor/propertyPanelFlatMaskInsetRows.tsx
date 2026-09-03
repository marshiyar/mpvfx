import {
  buildInsetClipPathSides,
  buildInsetClipPathValue,
  formatNumericValue,
  formatPxMetricValue,
  getClipPathInsetPx,
  inferClipPathPreset,
  parseInsetClipPathSides,
  parsePxMetricValue,
  type ClipPathInsetSides,
} from "./propertyPanelHelpers";
import { useTrackDesignInput } from "../../contexts/DesignPanelInputContext";
import { RotateCcw } from "../../icons/SystemIcons";
import { FlatSlider } from "./propertyPanelFlatPrimitives";
import { MetricField } from "./propertyPanelPrimitives";

/* ------------------------------------------------------------------ */
/*  Flat Mask inset — uniform slider + per-side fields                 */
/*  (split out of propertyPanelFlatStyleSections.tsx to stay under the */
/*  600-line file-size gate)                                           */
/* ------------------------------------------------------------------ */

export function FlatMaskInsetRows({
  clipPathValue,
  radiusValue,
  disabled,
  onSetStyle,
  onPreviewStyle,
}: {
  clipPathValue: string;
  radiusValue: number;
  disabled: boolean;
  onSetStyle: (prop: string, value: string) => void | Promise<unknown>;
  onPreviewStyle?: (prop: string, value: string) => void;
}) {
  const track = useTrackDesignInput();
  const clipPathPreset = inferClipPathPreset(clipPathValue);
  const parsedClipInsets = parseInsetClipPathSides(clipPathValue);
  const clipInsetValue = getClipPathInsetPx(clipPathValue);
  const clipInsetSides = parsedClipInsets ?? {
    top: clipInsetValue,
    right: clipInsetValue,
    bottom: clipInsetValue,
    left: clipInsetValue,
    radius: radiusValue,
  };
  const showClipInsetSides = clipPathPreset === "inset" || parsedClipInsets != null;

  const commitClipInsetSide = (side: keyof ClipPathInsetSides, nextValue: string) => {
    const next = parsePxMetricValue(nextValue);
    if (next == null) return;
    const sides: ClipPathInsetSides = {
      top: clipInsetSides.top,
      right: clipInsetSides.right,
      bottom: clipInsetSides.bottom,
      left: clipInsetSides.left,
    };
    sides[side] = next;
    void onSetStyle("clip-path", buildInsetClipPathSides(sides, clipInsetSides.radius));
  };

  const resetClipInsetSide = (side: keyof ClipPathInsetSides) => {
    if (disabled || clipInsetSides[side] === 0) return;
    const sides: ClipPathInsetSides = {
      top: clipInsetSides.top,
      right: clipInsetSides.right,
      bottom: clipInsetSides.bottom,
      left: clipInsetSides.left,
    };
    sides[side] = 0;
    track("button", `Reset mask inset ${side}`);
    void onSetStyle("clip-path", buildInsetClipPathSides(sides, clipInsetSides.radius));
  };

  const sideFields: Array<{ side: keyof ClipPathInsetSides; label: string }> = [
    { side: "top", label: "T" },
    { side: "right", label: "R" },
    { side: "bottom", label: "B" },
    { side: "left", label: "L" },
  ];

  return (
    <>
      <FlatSlider
        label="Mask inset"
        value={clipInsetValue}
        min={0}
        max={Math.max(120, Math.ceil(clipInsetValue))}
        step={1}
        tier={clipInsetValue > 0 ? "explicitCustom" : "default"}
        displayValue={`${formatNumericValue(clipInsetValue)}px`}
        disabled={disabled}
        onPreview={(next) =>
          onPreviewStyle?.("clip-path", buildInsetClipPathValue(next, radiusValue))
        }
        onCommit={(next) =>
          void onSetStyle("clip-path", buildInsetClipPathValue(next, radiusValue))
        }
        onReset={() =>
          void onSetStyle(
            "clip-path",
            buildInsetClipPathSides(
              { top: 0, right: 0, bottom: 0, left: 0 },
              clipInsetSides.radius,
            ),
          )
        }
      />
      {showClipInsetSides && (
        <div className="grid grid-cols-4 gap-2">
          {sideFields.map(({ side, label }) => (
            <div key={side} className="group relative min-w-0">
              <MetricField
                label={label}
                value={formatPxMetricValue(clipInsetSides[side])}
                disabled={disabled}
                onCommit={(next) => commitClipInsetSide(side, next)}
              />
              {clipInsetSides[side] !== 0 && (
                <button
                  type="button"
                  data-flat-mask-side-reset={side}
                  aria-label={`Reset ${label} mask inset`}
                  title="Reset inset side to zero"
                  disabled={disabled}
                  onClick={() => resetClipInsetSide(side)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 text-panel-text-3 opacity-0 transition-opacity hover:text-panel-text-1 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RotateCcw size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
