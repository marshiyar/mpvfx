import { useTimelineEditContextOptional } from "../timeline/TimelineEditContext";
import { useDomEditSelectionContextOptional } from "../canvas/DomEditContext";
import { useStudioShellContextOptional } from "../../app/StudioContext";
import { usePlayerStore } from "../../player/store/playerStore";
import { resolveNativeClipSelection } from "../../../shared/project/nativePropertyEditPlan";
import { scopedElementKey } from "../animation/GSAP/gsapKeyframeCacheHelpers";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import { useTrackDesignInput } from "./DesignPanelInputContext";
import type { DomEditSelection } from "../canvas/domEditing";
import { formatTimingValue, RESPONSIVE_GRID } from "./propertyPanelHelpers";
import { parseTimingValue } from "./propertyPanelTimingSection";
import { CommitField } from "./propertyPanelPrimitives";
import type { GsapAnimationEditCallbacks } from "../animation/GSAP/gsapAnimationCallbacks";
import { deriveElementTiming } from "./propertyPanelFlatTimingDerivation";
import { GsapAnimationList } from "../animation/GSAP/GsapAnimationList";

export function FlatTimingRow({
  element,
  animations = [],
  onSetAttribute,
  onSetAttributes,
}: {
  element: DomEditSelection;
  animations?: GsapAnimation[];
  onSetAttribute: (attr: string, value: string) => void | Promise<void>;
  /** Commits start+duration together in ONE atomic persist call, bound to
   *  THIS render's `element` explicitly — not whatever is "currently"
   *  selected by the time the call resolves. Falls back to two sequential
   *  `onSetAttribute` calls (with the same non-atomicity/misdirection risk
   *  documented below) when the caller doesn't wire it up. */
  onSetAttributes?: (
    selection: DomEditSelection,
    attrs: Record<string, string>,
  ) => Promise<void>;
}) {
  const track = useTrackDesignInput();
  const { onMoveElement, onResizeElement } = useTimelineEditContextOptional();
  const shell = useStudioShellContextOptional();
  const elements = usePlayerStore((state) => state.elements);
  const selectionContext = useDomEditSelectionContextOptional();
  const nativeDocument = selectionContext?.nativeProjectDocument;
  const nativeResolution = nativeDocument
    ? resolveNativeClipSelection(nativeDocument, element)
    : null;
  const selectedTimelineElement = elements.find(
    (candidate) => scopedElementKey(candidate) === scopedElementKey(element),
  );
  const nativeClip = nativeResolution?.ok
    ? nativeResolution.located.clip
    : null;
  const secondsPerFrame = nativeDocument
    ? nativeDocument.frameRate.denominator / nativeDocument.frameRate.numerator
    : 0;
  const timelineElement =
    selectedTimelineElement && nativeClip
      ? {
          ...selectedTimelineElement,
          start: nativeClip.startFrame * secondsPerFrame,
          duration: nativeClip.durationFrames * secondsPerFrame,
          playbackStart: nativeClip.sourceInFrame * secondsPerFrame,
        }
      : selectedTimelineElement;
  const inferredTiming = deriveElementTiming(element, animations);
  const {
    start,
    duration,
    inferred: derived,
  } = timelineElement && onMoveElement && onResizeElement
    ? {
        start: timelineElement.start,
        duration: timelineElement.duration,
        inferred: false,
      }
    : inferredTiming;
  const reportTimingFailure = (error: unknown) => {
    shell?.showToast(
      `Couldn’t change clip timing: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    throw error;
  };
  const end = start + duration;

  // While the range is inferred from animations, editing ONE field must pin the
  // WHOLE displayed range: writing only data-duration flips inference off and
  // drops start to data-start-or-0 (the clip silently shifts), and writing only
  // data-start is ignored while duration is still inferred (the edit looks
  // dead). Pin both attributes in ONE atomic commit bound to THIS element —
  // two sequential `onSetAttribute` calls would each resolve `domEditSelection`
  // fresh from current hook state, so a selection change between the two
  // awaits could misdirect the second write at the newly-selected element, and
  // a failure of just the second call would leave the pair half-applied.
  const pinRange = async (nextStart: number, nextDuration: number) => {
    const attrs = {
      start: nextStart.toFixed(2),
      duration: nextDuration.toFixed(2),
    };
    if (onSetAttributes) {
      await onSetAttributes(element, attrs);
      return;
    }
    await onSetAttribute("start", attrs.start);
    await onSetAttribute("duration", attrs.duration);
  };

  const commitStart = (nextValue: string) => {
    const parsed = parseTimingValue(nextValue);
    if (parsed == null || parsed < 0) return;
    if (timelineElement && onMoveElement)
      return Promise.resolve(
        onMoveElement(timelineElement, {
          start: parsed,
          track: timelineElement.track,
        }),
      ).catch(reportTimingFailure);
    if (derived) {
      void pinRange(parsed, duration);
      return;
    }
    void onSetAttribute("start", parsed.toFixed(2));
  };

  const commitDuration = (nextValue: string) => {
    const parsed = parseTimingValue(nextValue);
    if (parsed == null || parsed <= 0) return;
    if (timelineElement && onResizeElement)
      return Promise.resolve(
        onResizeElement(timelineElement, {
          start,
          duration: parsed,
          playbackStart: timelineElement.playbackStart,
        }),
      ).catch(reportTimingFailure);
    if (derived) {
      void pinRange(start, parsed);
      return;
    }
    void onSetAttribute("duration", parsed.toFixed(2));
  };

  const commitEnd = (nextValue: string) => {
    const parsed = parseTimingValue(nextValue);
    if (parsed == null || parsed <= start) return;
    if (timelineElement && onResizeElement)
      return Promise.resolve(
        onResizeElement(timelineElement, {
          start,
          duration: parsed - start,
          playbackStart: timelineElement.playbackStart,
        }),
      ).catch(reportTimingFailure);
    if (derived) {
      void pinRange(start, parsed - start);
      return;
    }
    void onSetAttribute("duration", (parsed - start).toFixed(2));
  };

  const cell = (
    label: string,
    value: string,
    onCommit: (next: string) => void | Promise<void>,
  ) => (
    <div className="grid gap-px">
      <span className="text-[9px] text-panel-text-4">{label}</span>
      <span className="border-b border-panel-border-input/50 font-mono text-[11px] text-panel-text-0 hover:border-panel-border-input">
        <CommitField
          ariaLabel={label}
          value={value}
          onCommit={(next) => {
            track("metric", label);
            return onCommit(next);
          }}
        />
      </span>
    </div>
  );

  return (
    <div className={RESPONSIVE_GRID}>
      {cell("Start", formatTimingValue(start), commitStart)}
      {cell("End", formatTimingValue(end), commitEnd)}
      {cell("Duration", formatTimingValue(duration), commitDuration)}
      {derived && (
        <p className="col-span-3 mt-1 text-[10px] leading-snug text-panel-text-3">
          Inferred from this element's animation — edit to pin an explicit clip
          range.
        </p>
      )}
    </div>
  );
}

export function FlatMotionSection({
  element,
  animations,
  showTiming,
  showEffects,
  multipleTimelines,
  unsupportedTimelinePattern,
  onSetAttribute,
  onSetAttributes,
  onAddAnimation,
  ...callbacks
}: {
  element: DomEditSelection;
  animations: GsapAnimation[];
  showTiming: boolean;
  showEffects: boolean;
  multipleTimelines?: boolean;
  unsupportedTimelinePattern?: boolean;
  onSetAttribute: (attr: string, value: string) => void | Promise<void>;
  onSetAttributes?: (
    selection: DomEditSelection,
    attrs: Record<string, string>,
  ) => Promise<void>;
  onAddAnimation: (method: "to" | "from" | "set" | "fromTo") => void;
} & GsapAnimationEditCallbacks) {
  // Only consume a focus request aimed at the element THIS panel renders (not
  // the store's selectedElementId, which flips synchronously during async
  // selection resolution), so a shared class-selector animation id can't open
  // the wrong element's editor.
  const renderedElementId = scopedElementKey(element);

  return (
    <div className="space-y-3">
      {showTiming && (
        <FlatTimingRow
          element={element}
          animations={animations}
          onSetAttribute={onSetAttribute}
          onSetAttributes={onSetAttributes}
        />
      )}
      {showEffects && (
        <>
          {multipleTimelines && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-400">
              This file has multiple GSAP timelines. Animation editing is
              disabled to prevent data loss — consolidate into a single timeline
              to enable editing.
            </p>
          )}
          {unsupportedTimelinePattern && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-400">
              This timeline uses a computed key the editor can&apos;t resolve
              statically.
            </p>
          )}
          {!multipleTimelines && !unsupportedTimelinePattern && (
            <GsapAnimationList
              {...callbacks}
              elementId={renderedElementId}
              animations={animations}
              onAddAnimation={onAddAnimation}
              variant="flat"
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * What the Motion section is called, and what its collapsed line says.
 *
 * "Motion" names the tween editor. On audio the section is Start/Duration/End
 * and nothing else, so the label would promise what it no longer offers — and
 * "Motion: 0 effects" on a sound is a category error, hence the span instead of
 * a count.
 *
 * Keyed on the TAG by its caller, not on whether the effects half is showing:
 * that half also disappears when a host simply has not wired the GSAP handlers,
 * and a div in that state is still a thing that moves — renaming its section
 * would be describing the host's wiring rather than the element.
 */
