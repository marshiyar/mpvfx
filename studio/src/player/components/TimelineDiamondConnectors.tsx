import { Fragment, useRef } from "react";
import { KEYFRAME_DRAG_THRESHOLD_PX } from "../../components/editor/keyframeDrag";
import { MiniCurveSvg } from "../../components/editor/EaseCurveSection";
import type { TimelineKeyframeTarget } from "./timelineKeyframeIdentity";
import { keyframeTimeLabel, type TimelineDiamondKeyframe } from "./timelineDiamondTypes";
import { timelineEaseFocusId } from "./timelineNavigationIdentity";

/** One diamond's geometry within its row, as computed by the lane. */
export interface TimelineDiamondMarker {
  keyframe: TimelineDiamondKeyframe;
  centerX: number;
  hitWidth: number;
  visualSize: number;
}

/**
 * The line between each pair of adjacent diamonds, plus the ease control that
 * sits at the segment's midpoint. Split out of TimelineClipDiamonds only to keep
 * that file inside the repo's file-size cap; it has no state of its own beyond
 * the press-position guard below.
 */
export function TimelineDiamondConnectors({
  markers,
  centerY,
  elementId,
  clipStart,
  clipDuration,
  rovingTargetId,
  baseColor,
  baseOpacity,
  groupAware,
  globalEase,
  keyframeTarget,
  onSelectSegment,
}: {
  markers: readonly TimelineDiamondMarker[];
  centerY: number;
  elementId: string;
  clipStart: number;
  clipDuration: number;
  /** Focus id of the one timeline control currently in the tab order. */
  rovingTargetId: string | null;
  baseColor: string;
  baseOpacity: number;
  groupAware: boolean;
  globalEase: string;
  keyframeTarget: (keyframe: TimelineDiamondKeyframe) => TimelineKeyframeTarget;
  onSelectSegment?: (target: TimelineKeyframeTarget) => void;
}) {
  return (
    <>
      {markers.map((marker, i) => {
        const previous = markers[i - 1];
        if (!previous) return null;
        const kf = marker.keyframe;
        const x1 = previous.centerX;
        const x2 = marker.centerX;
        if (x2 - x1 < 1) return null;
        const connectorLeft = x1 + previous.visualSize / 2;
        const connectorWidth = x2 - x1 - previous.visualSize / 2 - marker.visualSize / 2;
        // Native interpolation is outgoing and belongs to the segment's source
        // keyframe. Legacy GSAP easing remains incoming on the destination.
        const nativeSegment = Boolean(
          previous.keyframe.native || previous.keyframe.nativeTargets?.length,
        );
        const segmentKeyframe = nativeSegment ? previous.keyframe : kf;
        const target = keyframeTarget(segmentKeyframe);
        const presentation = nativeSegment
          ? nativeInterpolationPresentation(segmentKeyframe)
          : { ease: kf.ease ?? globalEase, label: kf.ease ?? globalEase, kind: "easing" as const };
        return (
          <Fragment key={`line-${i}-${previous.keyframe.percentage}-${kf.percentage}`}>
            <div
              className="absolute"
              data-keyframe-connector={groupAware ? "" : undefined}
              style={{
                left: connectorLeft,
                top: centerY,
                width: Math.max(0, connectorWidth),
                height: 2,
                transform: "translateY(-1px)",
                background: baseColor,
                opacity: baseOpacity,
                borderRadius: 1,
              }}
            />
            {onSelectSegment && showsEaseControl(segmentKeyframe, nativeSegment) && (
              <SegmentEaseControl
                left={x1}
                width={x2 - x1}
                centerY={centerY}
                ease={presentation.ease}
                displayLabel={presentation.label}
                descriptor={presentation.kind}
                target={target}
                focusId={timelineEaseFocusId(elementId, target)}
                rovingTargetId={rovingTargetId}
                afterLabel={keyframeTimeLabel(
                  clipStart,
                  clipDuration,
                  previous.keyframe.percentage,
                )}
                // connectorWidth is the clear span between the two diamonds'
                // edges, so a 24x24 target centred in it overhangs a diamond as
                // soon as the span is narrower than 24. The segment wrapper sits
                // at z-index 3, above the diamonds, so that overhang would win
                // the hit test and steal their clicks at fit zoom. Grow the
                // target only where the room exists.
                roomForFullTarget={connectorWidth >= 24}
                onSelectSegment={onSelectSegment}
              />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * The ease control targets one segment, so it needs the keyframe's own
 * animationId. A merged keyframe now shows one too: the editor edits every
 * colliding tween together, so one button standing for several curves is
 * honest. Only a keyframe with no source animation id (runtime-scanned) is left
 * out, because there is no tween to target.
 */
function showsEaseControl(kf: TimelineDiamondKeyframe, nativeSegment: boolean): boolean {
  if (!nativeSegment) return kf.animationId !== undefined;
  const targets = kf.nativeTargets ?? (kf.native ? [kf.native] : []);
  return targets.some((target) => target.hasFollowingKeyframe === true);
}

function nativeInterpolationPresentation(kf: TimelineDiamondKeyframe): {
  ease: string;
  label: string;
  kind: "interpolation";
} {
  const target = kf.nativeTargets?.[0] ?? kf.native;
  const outgoing = target?.outgoing ?? { type: "linear" as const };
  if (outgoing.type === "hold") {
    return { ease: "hold", label: "Hold", kind: "interpolation" };
  }
  if (outgoing.type === "linear") {
    return { ease: "none", label: "Linear", kind: "interpolation" };
  }
  const { x1, y1, x2, y2 } = outgoing.controlPoints;
  return {
    ease: `custom(M0,0 C${x1},${y1} ${x2},${y2} 1,1)`,
    label: "Cubic",
    kind: "interpolation",
  };
}

/**
 * The ease button centred on one connector segment, plus the transparent
 * wrapper that positions it. Split out of the connector map so that map stays a
 * geometry loop and this keeps the press guard, hit-target sizing and click
 * filtering together.
 */
function SegmentEaseControl({
  left,
  width,
  centerY,
  ease,
  displayLabel,
  descriptor,
  target,
  focusId,
  rovingTargetId,
  afterLabel,
  roomForFullTarget,
  onSelectSegment,
}: {
  left: number;
  width: number;
  centerY: number;
  ease: string;
  displayLabel: string;
  descriptor: "easing" | "interpolation";
  target: TimelineKeyframeTarget;
  focusId: string;
  /** Focus id of the one timeline control currently in the tab order. */
  rovingTargetId: string | null;
  /** Time label of the keyframe this segment starts at, for the accessible name. */
  afterLabel: string;
  roomForFullTarget: boolean;
  onSelectSegment: (target: TimelineKeyframeTarget) => void;
}) {
  // The ease button sits dead centre of its segment, which on a two-keyframe clip
  // is the centre of the clip bar, the natural place to grab a clip and drag it.
  // Swallowing pointerdown there made that grab a no-op. Instead the press falls
  // through to the clip (so the drag starts normally) and the button keeps only
  // the click, which we drop if the pointer actually travelled.
  const pressXRef = useRef<number | null>(null);
  return (
    <div
      className="group absolute"
      data-keyframe-ease-segment=""
      style={{
        left,
        top: centerY,
        width,
        height: 18,
        transform: "translateY(-50%)",
        // Own a stacking context above the diamond buttons. At fit zoom the 16px
        // ease control can overlap its neighbouring diamond; without a z-index
        // here the later diamond wins the hit test even though the child button
        // has z-index 3.
        zIndex: 3,
        // Only the centered control is interactive. The transparent segment
        // wrapper must not swallow connector/clip gestures.
        pointerEvents: "none",
      }}
    >
      <button
        type="button"
        data-keyframe-ease-button=""
        data-timeline-focus-id={focusId}
        tabIndex={focusId === rovingTargetId ? 0 : -1}
        aria-label={`Edit ${displayLabel} ${descriptor} after ${afterLabel}`}
        title={`Edit ${displayLabel} ${descriptor}`}
        // A visible 24x24 badge would collide with the diamonds either side, so
        // the WCAG 2.2 (2.5.8) target is met with a centered transparent
        // ::before overlay; the box stays 16x16. Where the segment is too narrow
        // for that overlay the button keeps its 16x16 hit area, which is WCAG's
        // target-spacing exception: the neighbouring diamonds are themselves the
        // reason it cannot grow, and stealing their clicks is the worse failure.
        className={`absolute flex items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 ${roomForFullTarget ? "before:absolute before:left-1/2 before:top-1/2 before:h-6 before:w-6 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']" : ""}`}
        style={{
          left: "50%",
          top: "50%",
          width: 16,
          height: 16,
          transform: "translate(-50%, -50%)",
          zIndex: 3,
          pointerEvents: "auto",
          padding: 0,
          border: "1px solid rgba(255, 255, 255, 0.14)",
          background: "#171717",
          cursor: "pointer",
        }}
        onPointerDown={(e) => {
          pressXRef.current = e.clientX;
        }}
        onClick={(e) => {
          e.stopPropagation();
          const pressX = pressXRef.current;
          pressXRef.current = null;
          if (pressX !== null && Math.abs(e.clientX - pressX) >= KEYFRAME_DRAG_THRESHOLD_PX) return;
          onSelectSegment(target);
        }}
      >
        <MiniCurveSvg ease={ease} active size={12} />
      </button>
    </div>
  );
}
