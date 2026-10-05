import type { ComponentProps } from "react";
import { Move } from "../../icons/SystemIcons";
import { KeyframeNavigation } from "../animation/Keyframe/KeyframeNavigation";
import { createGsapLivePreview } from "../animation/GSAP/gsapLivePreview";
import { PropertyPanel3dTransform } from "./propertyPanel3dTransform";
import { formatTransformValue, RESPONSIVE_GRID } from "./propertyPanelHelpers";
import type { PropertyPanelProps } from "./propertyPanelHelpers";
import { MetricField, Section } from "./propertyPanelPrimitives";

interface ClassicLayoutProps {
  element: NonNullable<PropertyPanelProps["element"]>;
  styles: Record<string, string>;
  manualOffsetEditingDisabled: boolean;
  manualSizeEditingDisabled: boolean;
  manualRotationEditingDisabled: boolean;
  displayX: number;
  displayY: number;
  displayW: number;
  displayH: number;
  displayR: number;
  commitManualOffset: (property: "x" | "y", value: string) => void;
  commitManualSize: (property: "width" | "height", value: string) => void;
  commitManualRotation: (value: string) => void;
  keyframeNavigationId: string | null;
  navKeyframes: ComponentProps<typeof KeyframeNavigation>["keyframes"];
  currentPct: number;
  currentFrame?: number;
  elDuration: number;
  elStart: number;
  seekFromKfPct: (percentage: number) => void;
  handleRemoveKeyframe: (animationId: string, percentage: number) => void;
  animIdForProp: (property: string) => string;
  handleConvertOrAddKeyframe: (property: string, value: number) => void;
  onCommitKeyframeProperty: PropertyPanelProps["onCommitKeyframeProperty"];
  onCommitAnimatedProperty: PropertyPanelProps["onCommitAnimatedProperty"];
  transform3dProps: ComponentProps<typeof PropertyPanel3dTransform>;
  iframeRef: { current: HTMLIFrameElement | null };
  onSetStyle: PropertyPanelProps["onSetStyle"];
}

/** Legacy same-origin layout and animation controls. */
export function PropertyPanelClassicLayout({
  element, styles, manualOffsetEditingDisabled, manualSizeEditingDisabled,
  manualRotationEditingDisabled, displayX, displayY, displayW, displayH,
  displayR, commitManualOffset, commitManualSize, commitManualRotation,
  keyframeNavigationId, navKeyframes, currentPct, currentFrame, elDuration,
  elStart, seekFromKfPct, handleRemoveKeyframe, animIdForProp,
  handleConvertOrAddKeyframe, onCommitKeyframeProperty, onCommitAnimatedProperty,
  transform3dProps, iframeRef, onSetStyle,
}: ClassicLayoutProps) {
  return (
          <Section title="Layout" icon={<Move size={15} />}>
            <div className={RESPONSIVE_GRID}>
              <div className="flex items-center gap-1">
                <div className="flex-1">
                  <MetricField
                    label="X"
                    value={formatTransformValue(displayX)}
                    disabled={manualOffsetEditingDisabled}
                    scrub
                    onCommit={(next) => commitManualOffset("x", next)}
                  />
                </div>
                {keyframeNavigationId && (
                  <KeyframeNavigation
                    property="x"
                    keyframes={navKeyframes}
                    currentPercentage={currentPct}
                    currentFrame={currentFrame}
                    clipDuration={elDuration}
                    onSeek={seekFromKfPct}
                    onAddKeyframe={() =>
                      (onCommitKeyframeProperty ?? onCommitAnimatedProperty) &&
                      void (onCommitKeyframeProperty ?? onCommitAnimatedProperty)!(element, "x", displayX)
                    }
                    onRemoveKeyframe={(pct, animationId) =>
                      handleRemoveKeyframe(animationId ?? animIdForProp("x"), pct)
                    }
                    onConvertToKeyframes={() => handleConvertOrAddKeyframe("x", displayX)}
                  />
                )}
              </div>
              <div className="flex items-center gap-1">
                <div className="flex-1">
                  <MetricField
                    label="Y"
                    value={formatTransformValue(displayY)}
                    disabled={manualOffsetEditingDisabled}
                    scrub
                    onCommit={(next) => commitManualOffset("y", next)}
                  />
                </div>
                {keyframeNavigationId && (
                  <KeyframeNavigation
                    property="y"
                    keyframes={navKeyframes}
                    currentPercentage={currentPct}
                    currentFrame={currentFrame}
                    clipDuration={elDuration}
                    onSeek={seekFromKfPct}
                    onAddKeyframe={() =>
                      (onCommitKeyframeProperty ?? onCommitAnimatedProperty) &&
                      void (onCommitKeyframeProperty ?? onCommitAnimatedProperty)!(element, "y", displayY)
                    }
                    onRemoveKeyframe={(pct, animationId) =>
                      handleRemoveKeyframe(animationId ?? animIdForProp("y"), pct)
                    }
                    onConvertToKeyframes={() => handleConvertOrAddKeyframe("y", displayY)}
                  />
                )}
              </div>
              <div className="flex items-center gap-1">
                <div className="flex-1">
                  <MetricField
                    label="W"
                    value={formatTransformValue(displayW)}
                    disabled={manualSizeEditingDisabled}
                    scrub
                    onCommit={(next) => commitManualSize("width", next)}
                  />
                </div>
                {keyframeNavigationId && (
                  <KeyframeNavigation
                    property="width"
                    keyframes={navKeyframes}
                    currentPercentage={currentPct}
                    currentFrame={currentFrame}
                    clipDuration={elDuration}
                    onSeek={seekFromKfPct}
                    onAddKeyframe={() =>
                      (onCommitKeyframeProperty ?? onCommitAnimatedProperty) &&
                      void (onCommitKeyframeProperty ?? onCommitAnimatedProperty)!(element, "width", displayW)
                    }
                    onRemoveKeyframe={(pct, animationId) =>
                      handleRemoveKeyframe(animationId ?? animIdForProp("width"), pct)
                    }
                    onConvertToKeyframes={() => handleConvertOrAddKeyframe("width", displayW)}
                  />
                )}
              </div>
              <div className="flex items-center gap-1">
                <div className="flex-1">
                  <MetricField
                    label="H"
                    value={formatTransformValue(displayH)}
                    disabled={manualSizeEditingDisabled}
                    scrub
                    onCommit={(next) => commitManualSize("height", next)}
                  />
                </div>
                {keyframeNavigationId && (
                  <KeyframeNavigation
                    property="height"
                    keyframes={navKeyframes}
                    currentPercentage={currentPct}
                    currentFrame={currentFrame}
                    clipDuration={elDuration}
                    onSeek={seekFromKfPct}
                    onAddKeyframe={() =>
                      (onCommitKeyframeProperty ?? onCommitAnimatedProperty) &&
                      void (onCommitKeyframeProperty ?? onCommitAnimatedProperty)!(element, "height", displayH)
                    }
                    onRemoveKeyframe={(pct, animationId) =>
                      handleRemoveKeyframe(animationId ?? animIdForProp("height"), pct)
                    }
                    onConvertToKeyframes={() => handleConvertOrAddKeyframe("height", displayH)}
                  />
                )}
              </div>
              <div className="flex items-center gap-1">
                <div className="flex-1">
                  <MetricField
                    label="R"
                    value={formatTransformValue(displayR, "°")}
                    disabled={manualRotationEditingDisabled}
                    onCommit={(next) => commitManualRotation(next.replace("°", ""))}
                  />
                </div>
                {keyframeNavigationId && (
                  <KeyframeNavigation
                    property="rotation"
                    keyframes={navKeyframes}
                    currentPercentage={currentPct}
                    currentFrame={currentFrame}
                    clipDuration={elDuration}
                    onSeek={seekFromKfPct}
                    onAddKeyframe={() =>
                      (onCommitKeyframeProperty ?? onCommitAnimatedProperty) &&
                      void (onCommitKeyframeProperty ?? onCommitAnimatedProperty)!(element, "rotation", displayR)
                    }
                    onRemoveKeyframe={(pct, animationId) =>
                      handleRemoveKeyframe(animationId ?? animIdForProp("rotation"), pct)
                    }
                    onConvertToKeyframes={() => handleConvertOrAddKeyframe("rotation", displayR)}
                  />
                )}
              </div>
            </div>
            <PropertyPanel3dTransform {...transform3dProps}
              onLivePreviewProps={createGsapLivePreview(iframeRef)} />
            <div className="mt-3">
              <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-neutral-600">
                Stacking
              </div>
              <MetricField
                label="Z-index"
                value={String(parseInt(styles["z-index"] || "auto", 10) || 0)}
                scrub
                onCommit={(next) => onSetStyle("z-index", next)}
              />
            </div>
          </Section>
  );
}
