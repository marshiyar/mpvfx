import { memo } from "react";
import { STUDIO_PREVIEW_FPS } from "../../player/lib/time";
import { KeyframeDiamond, type DiamondState } from "./KeyframeDiamond";

interface KeyframeNavigationProps {
  property: string;
  /** All keyframes for this element's tween, or null if no keyframes exist.
   *  `percentage` is clip-relative (element lifetime) for display/seek;
   *  `tweenPercentage` is the tween-relative value the writer/runtime key on. */
  keyframes: Array<{
    percentage: number;
    tweenPercentage?: number;
    /** Integer clip-local frame for native project keyframes. */
    nativeFrame?: number;
    properties: Record<string, number | string>;
    ease?: string;
    /** The tween that authored this keyframe, when the cache knows it. */
    animationId?: string;
  }> | null;
  /** Current playhead percentage within the element's lifetime (0-100) */
  currentPercentage: number;
  /** Integer clip-local frame. When supplied, native keyframes match exactly. */
  currentFrame?: number;
  /** Element lifetime in seconds; percentages above are relative to this span. */
  clipDuration?: number;
  onSeek: (percentage: number) => void;
  onAddKeyframe: (percentage: number) => void;
  /** `animationId` is the clicked keyframe's OWN tween; see handleDiamondClick. */
  onRemoveKeyframe: (percentage: number, animationId?: string) => void;
  onConvertToKeyframes: () => void;
}

/**
 * The preview playhead is frame-addressable at 30fps. A half-frame window
 * absorbs arithmetic/seek rounding without selecting neighbouring authored
 * keyframes. Unlike a fixed percentage, it does not expand on long clips.
 */
export function keyframeTolerancePercentage(clipDuration?: number): number {
  return Number.isFinite(clipDuration) && clipDuration! > 0
    ? 50 / STUDIO_PREVIEW_FPS / clipDuration!
    : 0;
}

interface NavigableKeyframe {
  percentage: number;
  tweenPercentage?: number;
  nativeFrame?: number;
  properties: Record<string, number | string>;
}

export function getKeyframeNavigationState<Keyframe extends NavigableKeyframe>(
  keyframes: readonly Keyframe[],
  currentPercentage: number,
  property?: string,
  clipDuration?: number,
  currentFrame?: number,
) {
  const propertyKeyframes = (property
    ? keyframes.filter((keyframe) => property in keyframe.properties)
    : [...keyframes]
  ).toSorted((a, b) => a.percentage - b.percentage);
  const tolerance = keyframeTolerancePercentage(clipDuration);
  const usesNativeFrames =
    Number.isInteger(currentFrame) &&
    propertyKeyframes.some((keyframe) => Number.isInteger(keyframe.nativeFrame));
  // Multiple authored keyframes can occupy one output frame on very short,
  // dense clips. Resolve exactly one nearest keyframe (earlier wins a tie), so
  // its adjacent arrows remain reachable instead of skipping a whole cluster.
  const currentKeyframe = usesNativeFrames
    ? (propertyKeyframes.find((keyframe) => keyframe.nativeFrame === currentFrame) ?? null)
    : propertyKeyframes.reduce<Keyframe | null>((nearest, keyframe) => {
        if (Math.abs(keyframe.percentage - currentPercentage) > tolerance) return nearest;
        if (!nearest) return keyframe;
        return Math.abs(keyframe.percentage - currentPercentage) <
          Math.abs(nearest.percentage - currentPercentage)
          ? keyframe
          : nearest;
      }, null);
  const currentIndex = currentKeyframe ? propertyKeyframes.indexOf(currentKeyframe) : -1;
  const priorIndex = propertyKeyframes.findLastIndex((keyframe) =>
    usesNativeFrames
      ? Number.isInteger(keyframe.nativeFrame) && keyframe.nativeFrame! < currentFrame!
      : keyframe.percentage < currentPercentage,
  );
  const nextIndex = propertyKeyframes.findIndex((keyframe) =>
    usesNativeFrames
      ? Number.isInteger(keyframe.nativeFrame) && keyframe.nativeFrame! > currentFrame!
      : keyframe.percentage > currentPercentage,
  );

  return {
    propertyKeyframes,
    prevKeyframe:
      (currentIndex >= 0 ? propertyKeyframes[currentIndex - 1] : propertyKeyframes[priorIndex]) ?? null,
    nextKeyframe:
      (currentIndex >= 0 ? propertyKeyframes[currentIndex + 1] : propertyKeyframes[nextIndex]) ?? null,
    currentKeyframe,
  };
}

/**
 * Convert a clip-relative percentage (element lifetime, used for display/seek) to
 * the TWEEN-relative percentage the GSAP writer/runtime key on. The clip→tween
 * map is linear, recovered from the keyframes' own (percentage, tweenPercentage)
 * pairs. Falls back to the input when there's no usable mapping (e.g. parser
 * keyframes that are already tween-relative, or fewer than two anchors).
 */
export function clipToTweenPercentage(
  keyframes: ReadonlyArray<{ percentage: number; tweenPercentage?: number }>,
  clipPct: number,
): number {
  const mapped = keyframes.filter((kf) => typeof kf.tweenPercentage === "number");
  if (mapped.length < 2) return clipPct;
  const a = mapped[0]!;
  const b = mapped[mapped.length - 1]!;
  if (b.percentage === a.percentage) return a.tweenPercentage!;
  const slope = (b.tweenPercentage! - a.tweenPercentage!) / (b.percentage - a.percentage);
  return a.tweenPercentage! + (clipPct - a.percentage) * slope;
}

function ArrowLeft({ disabled }: { disabled: boolean }) {
  return (
    <svg
      width="6"
      height="10"
      viewBox="0 0 6 10"
      fill="none"
      style={{ opacity: disabled ? 0.25 : 1 }}
    >
      <path
        d="M5 1L1 5L5 9"
        stroke="#a3a3a3"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArrowRight({ disabled }: { disabled: boolean }) {
  return (
    <svg
      width="6"
      height="10"
      viewBox="0 0 6 10"
      fill="none"
      style={{ opacity: disabled ? 0.25 : 1 }}
    >
      <path
        d="M1 1L5 5L1 9"
        stroke="#a3a3a3"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// fallow-ignore-next-line complexity
export const KeyframeNavigation = memo(function KeyframeNavigation({
  property,
  keyframes,
  currentPercentage,
  currentFrame,
  clipDuration,
  onSeek,
  onAddKeyframe,
  onRemoveKeyframe,
  onConvertToKeyframes,
}: KeyframeNavigationProps) {
  const {
    propertyKeyframes,
    prevKeyframe: prevKf,
    nextKeyframe: nextKf,
    currentKeyframe: atCurrent,
  } = getKeyframeNavigationState(
    keyframes ?? [],
    currentPercentage,
    property,
    clipDuration,
    currentFrame,
  );

  // Diamond state
  let diamondState: DiamondState;
  if (!keyframes || keyframes.length === 0) {
    diamondState = "ghost";
  } else if (atCurrent) {
    diamondState = "active";
  } else if (propertyKeyframes.length > 0) {
    diamondState = "inactive";
  } else {
    diamondState = "ghost";
  }

  // Keyframe add/remove are keyed by TWEEN-relative percentage (what the GSAP
  // writer + runtime use), not the clip-relative `currentPercentage` used for
  // display/seek. Removing on an existing keyframe uses its own tweenPercentage;
  // adding converts the clip-relative playhead through the keyframes' own
  // clip→tween linear mapping. Passing clip-relative % made the mutation miss
  // every keyframe (off by the tween's offset/scale) → a silent no-op on disk
  // while the optimistic cache hid it, so the motion path never refreshed.
  const handleDiamondClick = () => {
    if (diamondState === "ghost") {
      onConvertToKeyframes();
    } else if (diamondState === "active" && atCurrent) {
      // Report the keyframe's OWN tween. A merged gutter row shows the keyframes
      // of every tween in the property group, so the caller's "the group's
      // animation" guess names the wrong tween whenever the clicked keyframe
      // belongs to a sibling — and the writer then finds no keyframe at that
      // percentage and silently does nothing.
      onRemoveKeyframe(atCurrent.tweenPercentage ?? atCurrent.percentage, atCurrent.animationId);
    } else {
      onAddKeyframe(clipToTweenPercentage(propertyKeyframes, currentPercentage));
    }
  };

  return (
    // The two 12x20 steppers sit gap-0.5 apart with a 9px diamond between them,
    // so they stay below the 24px WCAG 2.2 (2.5.8) minimum under that criterion's
    // own spacing/inline exception: centred 24px targets here would overlap each
    // other AND the diamond, and one control swallowing its neighbour's clicks is
    // a worse 2.5.8 failure than a small target. Do not "fix" these to 24.
    <div className="flex h-5 items-center gap-0.5">
      <button
        type="button"
        disabled={!prevKf}
        onClick={() => prevKf && onSeek(prevKf.percentage)}
        title="Previous keyframe"
        aria-label={`Previous ${property} keyframe`}
        className="relative flex h-5 w-3 items-center justify-center disabled:cursor-default before:absolute before:-inset-1.5 before:content-['']"
      >
        <ArrowLeft disabled={!prevKf} />
      </button>
      <KeyframeDiamond
        state={diamondState}
        onClick={handleDiamondClick}
        size={9}
        title={
          diamondState === "ghost"
            ? `Convert ${property} to keyframes`
            : diamondState === "active"
              ? `Remove ${property} keyframe`
              : `Add ${property} keyframe`
        }
      />
      <button
        type="button"
        disabled={!nextKf}
        onClick={() => nextKf && onSeek(nextKf.percentage)}
        title="Next keyframe"
        aria-label={`Next ${property} keyframe`}
        className="relative flex h-5 w-3 items-center justify-center disabled:cursor-default before:absolute before:-inset-1.5 before:content-['']"
      >
        <ArrowRight disabled={!nextKf} />
      </button>
    </div>
  );
});
