import { Link, RotateCcw } from "../../icons/SystemIcons";
import {
  buildInsetClipPathSides,
  formatPxMetricValue,
  parseInsetClipPathSides,
  parsePxMetricValue,
  type ClipPathInsetSides,
} from "./propertyPanelHelpers";
import {
  resolveLinkedCropInsets,
  type CropEdge,
  type CropLinkState,
} from "./domEditOverlayCrop";
import { MetricField } from "./propertyPanelPrimitives";

const EMPTY_INSETS: ClipPathInsetSides = { top: 0, right: 0, bottom: 0, left: 0 };
const SIDES: ReadonlyArray<{ edge: CropEdge; label: string }> = [
  { edge: "top", label: "T" },
  { edge: "right", label: "R" },
  { edge: "bottom", label: "B" },
  { edge: "left", label: "L" },
];

function LinkButton({
  kind,
  label,
  active,
  disabled,
  onClick,
}: {
  kind: "all" | "vertical" | "horizontal";
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-crop-link={kind}
      data-crop-link-all={kind === "all" ? "true" : undefined}
      data-crop-link-vertical={kind === "vertical" ? "true" : undefined}
      data-crop-link-horizontal={kind === "horizontal" ? "true" : undefined}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center gap-1 border-b px-1 py-1 text-[10px] disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "border-panel-accent text-panel-accent"
          : "border-transparent text-panel-text-4 hover:text-panel-text-1"
      }`}
    >
      <Link size={11} />
      {kind === "all" ? "All" : kind === "vertical" ? "T/B" : "L/R"}
    </button>
  );
}

export function FlatCropControls({
  active,
  applying = false,
  links,
  clipPathValue,
  disabled,
  width,
  height,
  insets: sessionInsets,
  onStart,
  onApply,
  onCancel,
  onReset,
  onSetLinks,
  onSetStyle,
  onInsetsCommit,
}: {
  active: boolean;
  applying?: boolean;
  links: CropLinkState;
  clipPathValue: string;
  disabled: boolean;
  width?: number;
  height?: number;
  insets?: ClipPathInsetSides;
  onStart: () => void;
  onApply: () => void | Promise<unknown>;
  onCancel: () => void;
  onReset: () => void;
  onSetLinks: (links: CropLinkState) => void;
  onSetStyle: (prop: string, value: string) => void | Promise<unknown>;
  onInsetsCommit?: (
    insets: ClipPathInsetSides,
    clipPath: string,
  ) => void | Promise<unknown>;
}) {
  const parsed = parseInsetClipPathSides(clipPathValue);
  const insets: ClipPathInsetSides =
    sessionInsets ??
    (parsed
      ? { top: parsed.top, right: parsed.right, bottom: parsed.bottom, left: parsed.left }
      : EMPTY_INSETS);
  const unsupportedClip =
    Boolean(clipPathValue.trim()) && clipPathValue.trim() !== "none" && parsed === null;

  if (!active) {
    return (
      <div className="flex min-h-8 items-center justify-between">
        <span className="text-[11px] font-semibold text-panel-text-1">Crop</span>
        <button
          type="button"
          aria-label="Start cropping"
          disabled={disabled || unsupportedClip}
          title={unsupportedClip ? "This mask cannot be edited as a rectangular crop" : "Crop media"}
          onClick={onStart}
          className="text-[10px] font-medium text-panel-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          Crop
        </button>
      </div>
    );
  }

  const commit = (edge: CropEdge, rawValue: string, overrideLinks = links) => {
    const value = parsePxMetricValue(rawValue);
    if (value == null) return;
    const next = resolveLinkedCropInsets({
      insets,
      edge,
      value,
      links: overrideLinks,
      width,
      height,
    });
    const clipPath = buildInsetClipPathSides(next, 0);
    if (onInsetsCommit) return onInsetsCommit(next, clipPath);
    return onSetStyle("clip-path", clipPath);
  };
  const controlsDisabled = disabled || applying;

  return (
    <div className="ml-[1px] border-l-2 border-panel-border-input py-1 pl-[10px]">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-panel-text-1">Crop</span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Reset crop"
            disabled={controlsDisabled}
            onClick={onReset}
            className="text-panel-text-3 hover:text-panel-text-1 disabled:opacity-40"
          >
            <RotateCcw size={11} />
          </button>
          <button
            type="button"
            aria-label="Cancel crop"
            disabled={applying}
            onClick={onCancel}
            className="text-[10px] font-medium text-panel-text-3 hover:text-panel-text-1 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            aria-label="Apply crop"
            disabled={controlsDisabled}
            onClick={() => void onApply()}
            className="text-[10px] font-medium text-panel-accent disabled:opacity-40"
          >
            {applying ? "Applying…" : "Apply"}
          </button>
        </span>
      </div>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="text-[10px] text-panel-text-4">Link edges</span>
        <span className="flex items-center gap-1">
          <LinkButton
            kind="all"
            label={links.all ? "Unlink all crop edges" : "Link all crop edges"}
            active={links.all}
            disabled={controlsDisabled}
            onClick={() =>
              onSetLinks({
                all: !links.all,
                vertical: false,
                horizontal: false,
              })
            }
          />
          {!links.all && (
            <>
              <LinkButton
                kind="vertical"
                label={links.vertical ? "Unlink top and bottom" : "Link top and bottom"}
                active={links.vertical}
                disabled={controlsDisabled}
                onClick={() => onSetLinks({ ...links, vertical: !links.vertical })}
              />
              <LinkButton
                kind="horizontal"
                label={links.horizontal ? "Unlink left and right" : "Link left and right"}
                active={links.horizontal}
                disabled={controlsDisabled}
                onClick={() => onSetLinks({ ...links, horizontal: !links.horizontal })}
              />
            </>
          )}
        </span>
      </div>
      <div
        data-crop-measurements="true"
        className={links.all ? "grid grid-cols-1 gap-2" : "grid grid-cols-4 gap-2"}
      >
        {links.all ? (
          <div data-crop-measurement="all" className="min-w-0">
            <MetricField
              label="All"
              value={formatPxMetricValue(insets.top)}
              disabled={controlsDisabled}
              onCommit={(value) => commit("top", value, { ...links, all: true })}
            />
          </div>
        ) : (
          SIDES.map(({ edge, label }) => (
            <div key={edge} data-crop-measurement={edge} className="min-w-0">
              <MetricField
                label={label}
                value={formatPxMetricValue(insets[edge])}
                disabled={controlsDisabled}
                onCommit={(value) => commit(edge, value)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
