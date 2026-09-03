import { useTrackDesignInput } from "../../contexts/DesignPanelInputContext";
import { FlatRow, FlatSegmentedRow, FlatSelectRow } from "./propertyPanelFlatPrimitives";
import { KeyframeNavigation } from "./KeyframeNavigation";
import { formatPxMetricValue } from "./propertyPanelHelpers";
import { resolveValueTier } from "./propertyPanelValueTier";
import { PropertyPanel3dTransform } from "./propertyPanel3dTransform";
import type { DomEditSelection } from "./domEditingTypes";

type KeyframeEntry = Array<{
  percentage: number;
  tweenPercentage?: number;
  nativeFrame?: number;
  properties: Record<string, number | string>;
  ease?: string;
}> | null;

interface GeometryRowsProps {
  element: DomEditSelection;
  displayX: number;
  displayY: number;
  displayW: number;
  displayH: number;
  displayR: number;
  manualOffsetEditingDisabled: boolean;
  manualSizeEditingDisabled: boolean;
  manualRotationEditingDisabled: boolean;
  commitManualOffset: (axis: "x" | "y", value: string) => void;
  commitManualSize: (dimension: "width" | "height", value: string) => void;
  commitManualRotation: (value: string) => void;
  gsapAnimId: string | null;
  keyframeTargetId?: string | null;
  navKeyframes: KeyframeEntry;
  currentPct: number;
  currentFrame?: number;
  seekFromKfPct: (pct: number) => void;
  animIdForProp: (prop: string) => string;
  onCommitAnimatedProperty?: (
    element: DomEditSelection,
    property: string,
    value: number,
  ) => Promise<void>;
  onCommitKeyframeProperty?: (
    element: DomEditSelection,
    property: string,
    value: number,
  ) => Promise<void>;
  onRemoveKeyframe?: (animId: string, pct: number) => void;
  onConvertToKeyframes?: (animId: string) => void;
}

function KeyframeGutter({
  element,
  property,
  displayValue,
  gsapAnimId,
  navKeyframes,
  currentPct,
  currentFrame,
  seekFromKfPct,
  animIdForProp,
  onCommitAnimatedProperty,
  onCommitKeyframeProperty,
  onRemoveKeyframe,
  onConvertToKeyframes,
}: {
  property: string;
  displayValue: number;
} & Pick<
  GeometryRowsProps,
  | "element"
  | "gsapAnimId"
  | "navKeyframes"
  | "currentPct"
  | "currentFrame"
  | "seekFromKfPct"
  | "animIdForProp"
  | "onCommitAnimatedProperty"
  | "onCommitKeyframeProperty"
  | "onRemoveKeyframe"
  | "onConvertToKeyframes"
>) {
  const track = useTrackDesignInput();
  if (!gsapAnimId) return null;
  const hasKeyframesOnProp = Boolean(navKeyframes?.some((kf) => property in kf.properties));
  const addPropertyKeyframe = () => {
    const commit = onCommitKeyframeProperty ?? onCommitAnimatedProperty;
    if (!commit) return;
    track("button", `Add ${property} keyframe`);
    void commit(element, property, displayValue);
  };
  return (
    <span data-flat-kf-gutter="true" style={{ opacity: hasKeyframesOnProp ? 1 : 0.3 }}>
      <KeyframeNavigation
        property={property}
        keyframes={navKeyframes}
        currentPercentage={currentPct}
        currentFrame={currentFrame}
        onSeek={seekFromKfPct}
        onAddKeyframe={addPropertyKeyframe}
        onRemoveKeyframe={(pct, animationId) => {
          if (!onRemoveKeyframe) return;
          track("button", `Remove ${property} keyframe`);
          onRemoveKeyframe(animationId ?? animIdForProp(property), pct);
        }}
        onConvertToKeyframes={() => {
          if (onCommitKeyframeProperty) {
            addPropertyKeyframe();
            return;
          }
          // A sibling group (for example X/Y) may already be animated while
          // this property (for example rotation) has no authored keys. The
          // shared navigator correctly renders a ghost diamond for that
          // property, but converting its fallback animation would write to
          // the wrong tween. Author the missing property key at the current
          // displayed value instead, so it immediately participates in the
          // existing timeline interpolation.
          if (navKeyframes?.length && !hasKeyframesOnProp) {
            addPropertyKeyframe();
            return;
          }
          if (!onConvertToKeyframes) return;
          track("button", `Convert ${property} to keyframes`);
          onConvertToKeyframes(animIdForProp(property));
        }}
      />
    </span>
  );
}

export function LayoutGeometryRows({
  element,
  displayX,
  displayY,
  displayW,
  displayH,
  displayR,
  manualOffsetEditingDisabled,
  manualSizeEditingDisabled,
  manualRotationEditingDisabled,
  commitManualOffset,
  commitManualSize,
  commitManualRotation,
  gsapAnimId,
  keyframeTargetId,
  navKeyframes,
  currentPct,
  currentFrame,
  seekFromKfPct,
  animIdForProp,
  onCommitAnimatedProperty,
  onCommitKeyframeProperty,
  onRemoveKeyframe,
  onConvertToKeyframes,
}: GeometryRowsProps) {
  const gutterProps = {
    element,
    gsapAnimId: keyframeTargetId ?? gsapAnimId,
    navKeyframes,
    currentPct,
    currentFrame,
    seekFromKfPct,
    animIdForProp,
    onCommitAnimatedProperty,
    onCommitKeyframeProperty,
    onRemoveKeyframe,
    onConvertToKeyframes,
  };
  return (
    <>
      <FlatRow
        label="X"
        value={formatPxMetricValue(displayX)}
        tier={displayX === 0 ? "default" : "explicitCustom"}
        disabled={manualOffsetEditingDisabled}
        onCommit={(next) => commitManualOffset("x", next)}
        onReset={manualOffsetEditingDisabled ? undefined : () => commitManualOffset("x", "0px")}
        suffix={<KeyframeGutter property="x" displayValue={displayX} {...gutterProps} />}
      />
      <FlatRow
        label="Y"
        value={formatPxMetricValue(displayY)}
        tier={displayY === 0 ? "default" : "explicitCustom"}
        disabled={manualOffsetEditingDisabled}
        onCommit={(next) => commitManualOffset("y", next)}
        onReset={manualOffsetEditingDisabled ? undefined : () => commitManualOffset("y", "0px")}
        suffix={<KeyframeGutter property="y" displayValue={displayY} {...gutterProps} />}
      />
      <FlatRow
        label="W"
        value={formatPxMetricValue(displayW)}
        tier="default"
        disabled={manualSizeEditingDisabled}
        onCommit={(next) => commitManualSize("width", next)}
        suffix={<KeyframeGutter property="width" displayValue={displayW} {...gutterProps} />}
      />
      <FlatRow
        label="H"
        value={formatPxMetricValue(displayH)}
        tier="default"
        disabled={manualSizeEditingDisabled}
        onCommit={(next) => commitManualSize("height", next)}
        suffix={<KeyframeGutter property="height" displayValue={displayH} {...gutterProps} />}
      />
      <FlatRow
        label="Angle"
        value={`${displayR}°`}
        tier={displayR === 0 ? "default" : "explicitCustom"}
        disabled={manualRotationEditingDisabled}
        onCommit={(next) => commitManualRotation(next.replace("°", ""))}
        onReset={manualRotationEditingDisabled ? undefined : () => commitManualRotation("0")}
        suffix={<KeyframeGutter property="rotation" displayValue={displayR} {...gutterProps} />}
      />
    </>
  );
}

export function LayoutZIndexRow({
  styles,
  onSetStyle,
}: {
  styles: Record<string, string>;
  onSetStyle: (prop: string, value: string) => void | Promise<unknown>;
}) {
  const zIndex = String(parseInt(styles["z-index"] || "auto", 10) || 0);
  return (
    <FlatRow
      label="Z-index"
      value={zIndex}
      tier={resolveValueTier(styles["z-index"], "auto")}
      onCommit={(next) => void onSetStyle("z-index", next)}
      onReset={() => void onSetStyle("z-index", "auto")}
    />
  );
}

export function LayoutFlexBlock({
  styles,
  onSetStyle,
  disabled,
}: {
  styles: Record<string, string>;
  onSetStyle: (prop: string, value: string) => void | Promise<unknown>;
  disabled: boolean;
}) {
  const isFlex = styles.display === "flex" || styles.display === "inline-flex";
  if (!isFlex) return null;
  const direction = styles["flex-direction"] || "row";
  return (
    <div className="border-l-2 border-panel-border-input py-0.5 pl-[10px]">
      <div className="mb-[3px] text-[9px] font-semibold uppercase tracking-[0.12em] text-panel-text-5">
        Flex
      </div>
      <FlatSegmentedRow
        label="Direction"
        tier={resolveValueTier(styles["flex-direction"], "row") === "explicitCustom" ? "explicitCustom" : "default"}
        options={[
          { key: "row", node: "→ Row", label: "Row", active: direction === "row" },
          { key: "column", node: "Column", label: "Column", active: direction === "column" },
        ]}
        disabled={disabled}
        onChange={(next) => void onSetStyle("flex-direction", next)}
        onReset={() => void onSetStyle("flex-direction", "row")}
      />
      <FlatSelectRow
        label="Justify"
        value={styles["justify-content"] || "flex-start"}
        tier={resolveValueTier(styles["justify-content"], "flex-start")}
        disabled={disabled}
        options={[
          "flex-start",
          "center",
          "space-between",
          "space-around",
          "space-evenly",
          "flex-end",
        ]}
        onChange={(next) => void onSetStyle("justify-content", next)}
        onReset={() => void onSetStyle("justify-content", "flex-start")}
      />
      <FlatSelectRow
        label="Align"
        value={styles["align-items"] || "stretch"}
        tier={resolveValueTier(styles["align-items"], "stretch")}
        disabled={disabled}
        options={["stretch", "flex-start", "center", "flex-end", "baseline"]}
        onChange={(next) => void onSetStyle("align-items", next)}
        onReset={() => void onSetStyle("align-items", "stretch")}
      />
      <FlatRow
        label="Gap"
        value={styles.gap ?? "0px"}
        tier={resolveValueTier(styles.gap, "0px")}
        disabled={disabled}
        onCommit={(next) => void onSetStyle("gap", next.endsWith("px") ? next : `${next}px`)}
        onReset={disabled ? undefined : () => void onSetStyle("gap", "0px")}
      />
    </div>
  );
}

export function LayoutTransform3DBlock({
  gsapRuntimeValues,
  gsapAnimId,
  resolveAnimIdForProp,
  gsapKeyframes,
  currentPct,
  currentFrame,
  elStart,
  elDuration,
  element,
  onCommitAnimatedProperty,
  onCommitAnimatedProperties,
  onSeekToTime,
  onRemoveKeyframe,
  onConvertToKeyframes,
  onLivePreviewProps,
}: {
  gsapRuntimeValues: Record<string, number>;
  gsapAnimId: string | null;
  resolveAnimIdForProp?: (prop: string) => string | null;
  gsapKeyframes: Array<{
    percentage: number;
    nativeFrame?: number;
    properties: Record<string, number | string>;
    ease?: string;
  }> | null;
  currentPct: number;
  currentFrame?: number;
  elStart: number;
  elDuration: number;
  element: DomEditSelection;
  onCommitAnimatedProperty?: (
    element: DomEditSelection,
    property: string,
    value: number,
  ) => Promise<void>;
  onCommitAnimatedProperties?: (
    element: DomEditSelection,
    props: Record<string, number | string>,
  ) => Promise<void>;
  onSeekToTime?: (time: number) => void;
  onRemoveKeyframe?: (animId: string, pct: number) => void;
  onConvertToKeyframes?: (animId: string, duration?: number) => void;
  onLivePreviewProps?: (element: DomEditSelection, props: Record<string, number>) => void;
}) {
  return (
    <div className="border-t border-panel-hairline pt-2.5">
      <div className="mb-[3px] text-[9px] font-semibold uppercase tracking-[0.12em] text-panel-text-5">
        3D Transform
      </div>
      <PropertyPanel3dTransform
        gsapRuntimeValues={gsapRuntimeValues}
        gsapAnimId={gsapAnimId}
        resolveAnimIdForProp={resolveAnimIdForProp}
        gsapKeyframes={gsapKeyframes}
        currentPct={currentPct}
        currentFrame={currentFrame}
        elStart={elStart}
        elDuration={elDuration}
        element={element}
        onCommitAnimatedProperty={onCommitAnimatedProperty}
        onCommitAnimatedProperties={onCommitAnimatedProperties}
        onSeekToTime={onSeekToTime}
        onRemoveKeyframe={onRemoveKeyframe}
        onConvertToKeyframes={onConvertToKeyframes}
        onLivePreviewProps={onLivePreviewProps}
      />
    </div>
  );
}

interface FlatLayoutSectionProps
  extends
    Omit<GeometryRowsProps, never>,
    Pick<
      Parameters<typeof LayoutTransform3DBlock>[0],
      | "gsapRuntimeValues"
      | "resolveAnimIdForProp"
      | "gsapKeyframes"
      | "elStart"
      | "elDuration"
      | "onCommitAnimatedProperties"
      | "onSeekToTime"
      | "onLivePreviewProps"
    > {
  element: DomEditSelection;
  styles: Record<string, string>;
  onSetStyle: (prop: string, value: string) => void | Promise<unknown>;
  disabled: boolean;
}

export function FlatLayoutSection({
  element,
  styles,
  onSetStyle,
  disabled,
  gsapRuntimeValues,
  resolveAnimIdForProp,
  gsapKeyframes,
  elStart,
  elDuration,
  onCommitAnimatedProperties,
  onSeekToTime,
  onLivePreviewProps,
  ...geometry
}: FlatLayoutSectionProps) {
  const isCompositionRoot = element.element?.hasAttribute("data-composition-id") ?? false;
  return (
    <div className="space-y-1.5">
      <LayoutGeometryRows element={element} {...geometry} />
      <LayoutZIndexRow styles={styles} onSetStyle={onSetStyle} />
      <LayoutFlexBlock styles={styles} onSetStyle={onSetStyle} disabled={disabled} />
      {!isCompositionRoot ? (
        <LayoutTransform3DBlock
          gsapRuntimeValues={gsapRuntimeValues}
          gsapAnimId={geometry.gsapAnimId}
          resolveAnimIdForProp={resolveAnimIdForProp}
          gsapKeyframes={gsapKeyframes}
          currentPct={geometry.currentPct}
          currentFrame={geometry.currentFrame}
          elStart={elStart}
          elDuration={elDuration}
          element={element}
          onCommitAnimatedProperty={geometry.onCommitAnimatedProperty}
          onCommitAnimatedProperties={onCommitAnimatedProperties}
          onSeekToTime={onSeekToTime}
          onRemoveKeyframe={geometry.onRemoveKeyframe}
          onConvertToKeyframes={geometry.onConvertToKeyframes}
          onLivePreviewProps={onLivePreviewProps}
        />
      ) : null}
    </div>
  );
}
