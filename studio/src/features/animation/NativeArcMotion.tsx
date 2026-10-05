import { memo } from "react";
import type { ArcPathConfig } from "@hyperframes/core/gsap-parser";
import { ArcPathControls } from "./ArcPathControls";
import type { NativePositionPathChange } from "../canvas/useDomEditSession";
import type { NativePositionPathState } from "../../../shared/project/nativeKeyframeUiProjection";
import type { NativeMotionPath } from "../../../shared/project/nativeKeyframeTypes";

interface NativeArcMotionProps {
  path: { readonly clip: NativePositionPathChange["clip"]; readonly state: NativePositionPathState };
  onChange: (change: NativePositionPathChange) => Promise<void>;
}

const curvinessOf = (segment: NativeMotionPath | null): number =>
  segment?.type === "curve" ? segment.curviness : 1;

/**
 * The existing arc-motion controls, driven by a native clip's position path.
 * Every change goes to the document as a motion-path command; the engine
 * evaluates the result in preview and export alike.
 */
export const NativeArcMotion = memo(function NativeArcMotion({ path, onChange }: NativeArcMotionProps) {
  const { clip, state } = path;
  const arcPath: ArcPathConfig = {
    enabled: state.segments.some((segment) => segment !== null),
    autoRotate: state.autoRotate,
    segments: state.segments.map((segment) => ({ curviness: curvinessOf(segment) })),
  };
  return (
    <ArcPathControls
      arcPath={arcPath}
      segmentCount={state.frames.length - 1}
      onToggle={(enabled) =>
        void onChange({
          clip,
          segments: state.segments.map((segment, index) => ({
            frame: state.frames[index]!,
            path: enabled ? { type: "curve", curviness: curvinessOf(segment) } : null,
          })),
        })
      }
      onUpdateSegment={(index, update) => {
        if (typeof update.curviness !== "number") return;
        void onChange({
          clip,
          segments: [{ frame: state.frames[index]!, path: { type: "curve", curviness: update.curviness } }],
        });
      }}
      onToggleAutoRotate={(autoRotate) => void onChange({ clip, autoRotate })}
    />
  );
});
