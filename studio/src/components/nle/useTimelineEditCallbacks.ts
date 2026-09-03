import { useCallback, useMemo } from "react";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { TimelineElement } from "../../player";
import { usePlayerStore } from "../../player/store/playerStore";
import type { BlockedTimelineEditIntent } from "../../player/components/timelineEditing";
import type { TimelineEditCallbacks } from "../../player/components/timelineCallbacks";
import { useStudioShellContext } from "../../contexts/StudioContext";
import {
  useDomEditActionsContext,
  useDomEditSelectionContext,
} from "../../contexts/DomEditContext";
import { resolveTweenStart, resolveTweenDuration } from "../../utils/globalTimeCompiler";
import { resolveClipTimingBasis } from "../../hooks/useGsapTweenCache";
import {
  isRenderedKeyframeIdentityMatch,
  keyframeIsAtOutputTime,
} from "../../hooks/gsapShared";
import { elementCacheKeys } from "../../hooks/gsapKeyframeCacheHelpers";
import { resolveKeyframeRetime } from "../editor/keyframeRetime";
import type { DomEditSelection } from "../editor/domEditingTypes";
import { valuesAt } from "../../player/components/trackHeaderLaneValues";
import type { TimelineMoveOperation } from "../../hooks/timelineMoveAdapter";
import {
  getTimelineElementIdentity,
  splitTimelineElementKey,
} from "../../player/lib/timelineElementHelpers";
import {
  timelineKeyframeSelectionKey,
  type NativeTimelineKeyframeTarget,
  type TimelineKeyframeTarget,
} from "../../player/components/timelineKeyframeIdentity";
import { projectFrameFromSeconds } from "../../project/nativePropertyEditPlan";
import type { NativeProjectDocument } from "../../project/nativeProjectDocument";
import type { NativeProjectKeyframeTarget } from "../../hooks/useNativeProjectKeyframeCommands";
import type { NativeInterpolation } from "../../project/nativeKeyframeTypes";

export interface TimelineEditCallbackDeps {
  handleTimelineElementMove: (
    element: TimelineElement,
    updates: Pick<TimelineElement, "start" | "track">,
  ) => Promise<void> | void;
  handleTimelineElementsMove: (
    edits: Array<{ element: TimelineElement; updates: Pick<TimelineElement, "start" | "track"> }>,
    coalesceKey?: string,
    operation?: TimelineMoveOperation,
    coalesceMs?: number,
  ) => Promise<void> | void;
  handleTimelineElementResize: (
    element: TimelineElement,
    updates: Pick<TimelineElement, "start" | "duration" | "playbackStart">,
  ) => Promise<void> | void;
  handleTimelineGroupResize: NonNullable<TimelineEditCallbacks["onResizeElements"]>;
  handleToggleTrackHidden: (track: number, hidden: boolean) => Promise<void> | void;
  setAudioGroupAttribute: {
    setLive: (groupId: string, attr: string, value: string | null) => void;
    setQuiet: (groupId: string, attr: string, value: string | null, label: string) => Promise<void>;
  };
  handleBlockedTimelineEdit: (element: TimelineElement, intent: BlockedTimelineEditIntent) => void;
  handleTimelineElementSplit: (element: TimelineElement, splitTime: number) => Promise<void> | void;
  handleRazorSplit: (element: TimelineElement, splitTime: number) => Promise<void> | void;
  handleRazorSplitAll: (splitTime: number) => Promise<void> | void;
  /** C1's ungrouped-track FX pointer — same auto-grouping write B6's carve uses. */
  handleGroupClips?: (
    clipIds: readonly string[],
    groupId: string,
    groupLabel?: string,
  ) => Promise<void>;
  /** C1's single-clip FX write, addressed by the clip itself. */
  setElementFxAttribute?: {
    setLive: (element: TimelineElement, attr: string, value: string | null) => void;
    setQuiet: (
      element: TimelineElement,
      attr: string,
      value: string | null,
      label: string,
    ) => Promise<void>;
  };
}

interface TimelineKeyframeTargetAnimation {
  id: string;
  propertyGroup?: string | null;
  keyframes?: unknown;
}

interface TimelineCachedKeyframe {
  percentage: number;
  tweenPercentage?: number;
  propertyGroup?: string;
  animationId?: string;
}

function nativeCommandTargetsFromTimelineTargets(
  targets: readonly NativeTimelineKeyframeTarget[],
): readonly NativeProjectKeyframeTarget[] {
  const first = targets[0];
  if (!first) return [];
  if (
    targets.some(
      (target) =>
        target.sequenceId !== first.sequenceId ||
        target.trackId !== first.trackId ||
        target.clipId !== first.clipId ||
        target.frame !== first.frame,
    )
  ) {
    return [];
  }
  return targets.map((native) => ({
    sequenceId: native.sequenceId,
    trackId: native.trackId,
    clipId: native.clipId,
    parameterId: native.parameterId,
    frame: native.frame,
  }));
}

function nativeCommandTargets(
  target: TimelineKeyframeTarget,
): readonly NativeProjectKeyframeTarget[] | null {
  const nativeTargets = target.nativeTargets?.length
    ? target.nativeTargets
    : target.native
      ? [target.native]
      : null;
  return nativeTargets ? nativeCommandTargetsFromTimelineTargets(nativeTargets) : null;
}

function nativeClipForTarget(
  document: NativeProjectDocument | null,
  target: NativeProjectKeyframeTarget | undefined,
) {
  if (!document || !target || document.sequence.id !== target.sequenceId) return null;
  const track = document.sequence.tracks.find((candidate) => candidate.id === target.trackId);
  const clip = track?.clips.find((candidate) => candidate.id === target.clipId);
  return clip ?? null;
}

/**
 * Resolve a rendered timeline diamond back to the animation that authored it.
 * Prefer the animation identity carried by the rendered keyframe. Legacy cache
 * entries without one are safe only when their property group has one candidate;
 * ambiguous candidates remain unresolved rather than retiming an arbitrary tween.
 */
export function resolveTimelineKeyframeTarget(
  pct: number,
  keyframes: ReadonlyArray<TimelineCachedKeyframe>,
  animations: ReadonlyArray<TimelineKeyframeTargetAnimation>,
  timing: { start?: number; duration?: number } = {},
): { animId: string; tweenPct: number } | null {
  const rendered = keyframes.find(
    (item) =>
      item.animationId !== undefined &&
      isRenderedKeyframeIdentityMatch(item, { percentage: pct }, timing),
  );
  // A rendered diamond already carries its author identity. Do not let a nearby
  // cache row substitute for it; dense lanes routinely have several per frame.
  if (rendered?.animationId !== undefined) {
    const identifiedAnimation = animations.find((animation) => animation.id === rendered.animationId);
    return identifiedAnimation
      ? { animId: identifiedAnimation.id, tweenPct: rendered.tweenPercentage ?? pct }
      : null;
  }
  const kf = keyframes.find((item) =>
    isRenderedKeyframeIdentityMatch(item, { percentage: pct }, timing),
  );
  if (!kf) return null;
  const identifiedAnimation = kf.animationId
    ? animations.find((animation) => animation.id === kf.animationId)
    : undefined;
  if (kf.animationId) {
    return identifiedAnimation
      ? { animId: identifiedAnimation.id, tweenPct: kf.tweenPercentage ?? pct }
      : null;
  }
  const group = kf?.propertyGroup;
  const candidates = group
    ? animations.filter((animation) => animation.propertyGroup === group)
    : animations.filter((animation) => !animation.propertyGroup);
  const animation = candidates.length === 1 ? candidates[0] : undefined;
  return animation ? { animId: animation.id, tweenPct: kf.tweenPercentage ?? pct } : null;
}

/**
 * Builds the timeline edit callback bag (move/resize/split/razor plus the
 * keyframe-diamond callbacks) provided to `<Timeline>` via TimelineEditProvider.
 * The keyframe callbacks resolve the dragged diamond back to its GSAP anim id +
 * tween-relative percentage, reading DOM-edit selection state from context.
 */
// fallow-ignore-next-line complexity
export function useTimelineEditCallbacks({
  handleTimelineElementMove,
  handleTimelineElementsMove,
  handleTimelineElementResize,
  handleTimelineGroupResize,
  handleToggleTrackHidden,
  setAudioGroupAttribute,
  handleBlockedTimelineEdit,
  handleTimelineElementSplit,
  handleRazorSplit,
  handleRazorSplitAll,
  handleGroupClips,
  setElementFxAttribute,
}: TimelineEditCallbackDeps): TimelineEditCallbacks {
  const { projectId, activeCompPath } = useStudioShellContext();
  const { domEditSelection, selectedGsapAnimations, nativeProjectDocument } =
    useDomEditSelectionContext();
  const {
    handleGsapRemoveKeyframe,
    handleGsapMoveKeyframeToPlayhead,
    handleGsapMoveKeyframe,
    handleGsapResizeKeyframedTween,
    handleGsapUpdateMeta,
    handleGsapAddKeyframeBatch,
    handleGsapConvertToKeyframes,
    handleGsapRemoveAllKeyframes,
    buildDomSelectionForTimelineElement,
    deleteNativeKeyframe,
    deleteNativeKeyframes,
    deleteAllNativeKeyframes,
    moveNativeKeyframe,
    moveNativeKeyframes,
    setNativeKeyframeInterpolation,
    setNativeKeyframesInterpolation,
  } = useDomEditActionsContext();

  const resolveElementAnimations = useCallback(
    (elementKey: string): GsapAnimation[] => {
      const { gsapAnimations } = usePlayerStore.getState();
      const { sourceFile, domId } = splitTimelineElementKey(elementKey);
      const scope = sourceFile ?? activeCompPath ?? "index.html";
      // elementCacheKeys owns the key-variant list the writers use; reading it
      // back by hand here is how the two sides drift.
      for (const key of elementCacheKeys(scope, domId)) {
        const animations = gsapAnimations.get(key);
        if (animations) return animations;
      }
      return [];
    },
    [activeCompPath],
  );

  // Resolve a timeline-diamond callback's clip-% to the keyframe's anim id + its
  // tween-relative percentage (shared by the delete/move keyframe callbacks): the
  // diamond reports a clip-% but the script ops key on the tween-%. Prefers the
  // anim in the keyframe's property group, falling back to the first keyframed one.
  const resolveKeyframeTarget = useCallback(
    (
      elementKey: string,
      target: TimelineKeyframeTarget,
      animations: GsapAnimation[] = selectedGsapAnimations,
    ): { animId: string; tweenPct: number } | null => {
      const carriesIdentity =
        target.propertyGroup !== undefined ||
        target.tweenPercentage !== undefined ||
        target.animationId !== undefined;
      // The clicked element's own cache: the diamond context menu can open on an
      // element that is not the selected one, and reading the selection's cache
      // there resolves against the wrong element.
      const keyframeCache = usePlayerStore.getState().keyframeCache;
      const cached =
        keyframeCache.get(elementKey) ??
        keyframeCache.get(splitTimelineElementKey(elementKey).domId);
      const element = usePlayerStore
        .getState()
        .elements.find((candidate) => (candidate.key ?? candidate.id) === elementKey);
      return resolveTimelineKeyframeTarget(
        target.percentage,
        carriesIdentity ? [target] : (cached?.keyframes ?? []),
        animations,
        element ? { start: element.start, duration: element.duration } : undefined,
      );
    },
    [selectedGsapAnimations],
  );

  const removeKeyframeTarget = useCallback(
    (animationId: string, percentage: number, selectionOverride?: DomEditSelection | null) => {
      // A flat tween's two diamonds are SYNTHESIZED endpoints, not authored
      // keyframes, so "remove keyframe" has nothing to remove. Escalating to a
      // whole-animation delete here destroyed the authored tween and its source
      // comment on a single click, with no undo beyond the editor's own stack.
      // Always post remove-keyframe: the writer refuses it for a flat tween
      // (`changed:false`, file untouched), which is the correct no-op.
      handleGsapRemoveKeyframe(animationId, percentage, undefined, selectionOverride);
    },
    [handleGsapRemoveKeyframe],
  );

  return useMemo(
    () => ({
      onMoveElement: handleTimelineElementMove,
      onMoveElements: handleTimelineElementsMove,
      onResizeElement: handleTimelineElementResize,
      onResizeElements: handleTimelineGroupResize,
      onToggleTrackHidden: handleToggleTrackHidden,
      onSetAudioGroupAttributeLive: setAudioGroupAttribute.setLive,
      onSetAudioGroupAttributeQuiet: setAudioGroupAttribute.setQuiet,
      onGroupClips: handleGroupClips,
      onSetElementAttributeLive: setElementFxAttribute?.setLive,
      onSetElementAttributeQuiet: setElementFxAttribute?.setQuiet,
      onBlockedEditAttempt: handleBlockedTimelineEdit,
      onSplitElement: handleTimelineElementSplit,
      onRazorSplit: handleRazorSplit,
      onRazorSplitAll: handleRazorSplitAll,
      onDeleteAllKeyframes: (element, animationId, native) => {
        if (native) {
          const nativeTimelineTargets = Array.isArray(native)
            ? native
            : [native as NativeTimelineKeyframeTarget];
          const nativeTargets = nativeCommandTargetsFromTimelineTargets(nativeTimelineTargets);
          const primaryTarget = nativeTargets[0];
          if (
            !primaryTarget ||
            !nativeProjectDocument ||
            primaryTarget.sequenceId !== nativeProjectDocument.sequence.id
          ) {
            return;
          }
          const track = nativeProjectDocument.sequence.tracks.find(
            (candidate) => candidate.id === primaryTarget.trackId,
          );
          const clip = track?.clips.find((candidate) => candidate.id === primaryTarget.clipId);
          if (!clip) return;
          let projectFrame: number;
          try {
            projectFrame = projectFrameFromSeconds(
              usePlayerStore.getState().currentTime,
              nativeProjectDocument.frameRate,
            );
          } catch {
            return;
          }
          const localFrame = projectFrame - clip.startFrame;
          if (localFrame < 0 || localFrame >= clip.durationFrames) return;
          const collapseTargets = nativeTargets.map((target) => ({ ...target, frame: localFrame }));
          void deleteAllNativeKeyframes(
            collapseTargets.length === 1 ? collapseTargets[0]! : collapseTargets,
          );
          return;
        }
        // Hold the element where it is (collapse keyframes to a static set) rather
        // than deleting the whole animation — deleting strands a stale GSAP base
        // that the next drag adds to, flinging the element off-screen.
        const elementKey = getTimelineElementIdentity(element);
        // An explicit animation id scopes the delete to the lane whose menu was
        // opened; without one this is the layer-wide action, and that means
        // EVERY keyframed tween, not just the first. A layer with position AND
        // opacity keyframes used to leave the second one keyframed, so "Delete
        // All Keyframes" visibly did half the job. A stale id matches nothing
        // and deletes nothing, which is the point: it never falls back to a
        // lane the user did not click.
        const animations = resolveElementAnimations(elementKey);
        const anims = animationId
          ? animations.filter((animation) => animation.id === animationId)
          : animations.filter((animation) => animation.keyframes);
        if (anims.length === 0) return;
        void buildDomSelectionForTimelineElement(element).then(async (selection) => {
          if (!selection) return;
          // Serial: each removal rewrites the same source file, so dispatching
          // them together would have the later writes read a pre-edit document.
          for (const anim of anims) await handleGsapRemoveAllKeyframes(anim.id, selection);
        });
      },
      onDeleteKeyframe: (elId, keyframe) => {
        const nativeTargets = nativeCommandTargets(keyframe);
        if (nativeTargets) {
          if (nativeTargets.length === 0) return;
          if (nativeTargets.length === 1) void deleteNativeKeyframe(nativeTargets[0]!);
          else void deleteNativeKeyframes(nativeTargets);
          return;
        }
        const animations = resolveElementAnimations(elId);
        const target = resolveKeyframeTarget(elId, keyframe, animations);
        if (!target) return;
        const element = usePlayerStore.getState().elements.find((el) => (el.key ?? el.id) === elId);
        if (!element) {
          removeKeyframeTarget(target.animId, target.tweenPct);
          return;
        }
        // Persist through the CLICKED element's own selection so a deletion on a
        // non-selected element (especially one in a different source file) commits
        // against the right element instead of the current domEditSelection.
        void buildDomSelectionForTimelineElement(element).then((selection) => {
          if (selection) removeKeyframeTarget(target.animId, target.tweenPct, selection);
        });
      },
      // Retime the keyframe to the playhead, preserving its value + ease. The
      // clicked element owns the whole write: its animations resolve the target,
      // its selection commits it, and its animation computes the playhead
      // percentage. Mixing frames here retimed against the selected element's
      // tween and wrote the result into the clicked element's file.
      onMoveKeyframeToPlayhead: (element, keyframe) => {
        const nativeTargets = nativeCommandTargets(keyframe);
        const nativeTarget = nativeTargets?.[0];
        const nativeClip = nativeClipForTarget(nativeProjectDocument, nativeTarget);
        if (nativeTargets) {
          if (!nativeTarget || nativeTargets.length === 0) return;
          // A native address is authoritative. If it is stale, out of range, or
          // rejected by the atomic command layer, never reinterpret the click as
          // a legacy GSAP edit and never clamp it onto a different frame.
          if (!nativeClip || !nativeProjectDocument) return;
          let projectFrame: number;
          try {
            projectFrame = projectFrameFromSeconds(
              usePlayerStore.getState().currentTime,
              nativeProjectDocument.frameRate,
            );
          } catch {
            return;
          }
          const toFrame = projectFrame - nativeClip.startFrame;
          if (toFrame < 0 || toFrame >= nativeClip.durationFrames) return;
          if (toFrame === nativeTarget.frame) return;

          const elementId = getTimelineElementIdentity(element);
          const originalSelection = usePlayerStore.getState().selectedKeyframes;
          const originalSelectionKey = timelineKeyframeSelectionKey(elementId, keyframe);
          const rekeySelection = originalSelection.has(originalSelectionKey);
          const move = nativeTargets.length === 1
            ? moveNativeKeyframe(nativeTarget, toFrame)
            : moveNativeKeyframes(nativeTargets, toFrame);
          void move
            .then(() => {
              if (!rekeySelection) return;
              const current = usePlayerStore.getState();
              // Do not overwrite a selection the user changed while persistence
              // was in flight. The committed key remains valid even when it is
              // no longer the active selection.
              if (
                current.selectedElementId !== elementId ||
                current.selectedKeyframes !== originalSelection
              ) {
                return;
              }
              const percentage = (toFrame / nativeClip.durationFrames) * 100;
              const nextSelection = new Set(originalSelection);
              nextSelection.delete(originalSelectionKey);
              nextSelection.add(
                timelineKeyframeSelectionKey(elementId, {
                  ...keyframe,
                  percentage,
                  tweenPercentage: percentage,
                  native: { ...keyframe.native!, frame: toFrame },
                  ...(keyframe.nativeTargets
                    ? {
                        nativeTargets: keyframe.nativeTargets.map((target) => ({
                          ...target,
                          frame: toFrame,
                        })),
                      }
                    : {}),
                }),
              );
              usePlayerStore.setState({ selectedKeyframes: nextSelection });
            })
            .catch(() => {
              // The command layer reports missing/occupied frames and repository
              // conflicts by rejection. Keeping the original selection is the
              // complete UI rollback for this context-menu action.
            });
          return;
        }
        const elementKey = getTimelineElementIdentity(element);
        const animations = resolveElementAnimations(elementKey);
        const target = resolveKeyframeTarget(elementKey, keyframe, animations);
        const animation = target
          ? animations.find((candidate) => candidate.id === target.animId)
          : undefined;
        if (!target || !animation) return;
        void buildDomSelectionForTimelineElement(element).then((selection) => {
          if (selection) {
            handleGsapMoveKeyframeToPlayhead(target.animId, target.tweenPct, selection, animation);
          }
        });
      },
      onSetKeyframeInterpolation: (_elementId, keyframe, outgoing: NativeInterpolation) => {
        const nativeTargets = nativeCommandTargets(keyframe);
        if (!nativeTargets || nativeTargets.length === 0) return;
        if (nativeTargets.length === 1) {
          void setNativeKeyframeInterpolation(nativeTargets[0]!, outgoing);
        } else {
          void setNativeKeyframesInterpolation(nativeTargets, outgoing);
        }
      },
      // Drag-to-retime. The diamond reports clip-%s; resolveKeyframeTarget gives
      // the dragged keyframe's anim + tween-%. We convert the clip-% drop to an
      // absolute time (via the clip's timing basis) and let resolveKeyframeRetime
      // decide: a drop inside the tween window is a plain move (re-key tween-%); a
      // drop past the boundary (last keyframe past the end, first before the start)
      // resizes the tween — position/duration grow so the dragged keyframe lands at
      // the drop while every other keyframe keeps its absolute time (value+ease too).
      // fallow-ignore-next-line complexity
      onMoveKeyframe: async (elId, keyframe, toClipPct) => {
        const nativeTargets = nativeCommandTargets(keyframe);
        const nativeTarget = nativeTargets?.[0];
        const nativeClip = nativeClipForTarget(nativeProjectDocument, nativeTarget);
        if (nativeTargets) {
          if (!nativeTarget || !nativeClip || nativeTargets.length === 0) return false;
          const toFrame = Math.max(
            0,
            Math.min(
              nativeClip.durationFrames - 1,
              Math.round((toClipPct / 100) * nativeClip.durationFrames),
            ),
          );
          if (toFrame === nativeTarget.frame) return true;
          try {
            if (nativeTargets.length === 1) await moveNativeKeyframe(nativeTarget, toFrame);
            else await moveNativeKeyframes(nativeTargets, toFrame);
            return true;
          } catch {
            return false;
          }
        }
        const animations = resolveElementAnimations(elId);
        const target = resolveKeyframeTarget(elId, keyframe, animations);
        if (!target) return false;
        // The dragged diamond's OWN element, not the selected one: a drag on a
        // non-selected clip has to read that clip's animations and commit
        // through that clip's selection, or it retimes whatever is selected.
        const element = usePlayerStore.getState().elements.find((el) => (el.key ?? el.id) === elId);
        const sel = element ? await buildDomSelectionForTimelineElement(element) : domEditSelection;
        if (!sel) return false;
        const anim = animations.find((a) => a.id === target.animId);
        const tweenStart = anim ? resolveTweenStart(anim) : null;
        if (!anim || tweenStart === null) return Promise.resolve(false);
        const sourceFile = sel.sourceFile || activeCompPath || "index.html";
        const { elements, domClipChildren } = usePlayerStore.getState();
        const { elStart, elDuration } = resolveClipTimingBasis(
          sel.id ?? "",
          sourceFile,
          elements,
          domClipChildren,
        );
        const tweenDuration = resolveTweenDuration(anim, elDuration);
        const dropAbsTime = elStart + (toClipPct / 100) * elDuration;
        const decision = resolveKeyframeRetime({
          keyframes: anim.keyframes?.keyframes ?? [],
          draggedTweenPct: target.tweenPct,
          tweenStart,
          tweenDuration,
          dropAbsTime,
        });
        if (decision.kind === "move" && decision.toTweenPct != null) {
          return handleGsapMoveKeyframe(target.animId, target.tweenPct, decision.toTweenPct, sel);
        } else if (
          decision.kind === "resize" &&
          decision.pctRemap &&
          decision.position != null &&
          decision.duration != null
        ) {
          // An empty remap means a FLAT tween's synthesized boundary: there is no
          // keyframe node to re-key, only the window to move. Sending it through
          // the keyframed-resize writer would rewrite the authored flat tween into
          // keyframes form as a side effect of a pure position/duration change, so
          // dispatch update-meta and leave the tween as the author wrote it.
          if (decision.pctRemap.length === 0) {
            // Report the write's real settlement, like every other branch here:
            // answering `true` while the meta update is still in flight tells the
            // diamond the retime landed, so a rejected write never snaps back.
            return handleGsapUpdateMeta(
              target.animId,
              { position: decision.position, duration: decision.duration },
              sel,
            );
          }
          return handleGsapResizeKeyframedTween(
            target.animId,
            decision.position,
            decision.duration,
            decision.pctRemap,
            sel,
          );
        }
        return Promise.resolve(false);
      },
      // fallow-ignore-next-line complexity
      onToggleKeyframeAtPlayhead: (el: TimelineElement) => {
        const currentTime = usePlayerStore.getState().currentTime;
        // Same frame for read and write: the toggled element's animations decide
        // add-vs-remove, and its selection is what the mutation commits through.
        const animations = resolveElementAnimations(getTimelineElementIdentity(el));
        void buildDomSelectionForTimelineElement(el).then((selection) => {
          if (!selection) return;
          const anim = animations.find((a) => a.keyframes);
          if (anim?.keyframes) {
            const tweenStart = resolveTweenStart(anim);
            const tweenDuration = resolveTweenDuration(anim, el.duration);
            const pct =
              tweenStart !== null
                ? Math.max(0, Math.min(100, ((currentTime - tweenStart) / tweenDuration) * 100))
                : el.duration > 0
                  ? Math.max(0, Math.min(100, ((currentTime - el.start) / el.duration) * 100))
                  : 0;
            const existing = anim.keyframes.keyframes.find(
              (k) =>
                tweenStart !== null
                  ? keyframeIsAtOutputTime(k.percentage, currentTime, {
                      start: tweenStart,
                      duration: tweenDuration,
                    })
                  : k.percentage === pct,
            );
            if (existing) {
              handleGsapRemoveKeyframe(anim.id, existing.percentage, undefined, selection);
            } else if (anim.propertyGroup) {
              // Keep this legacy whole-layer toggle inside the authored lane:
              // sampling the animation preserves opacity/rotation/etc. values at
              // the playhead instead of inventing a position keyframe.
              const properties = valuesAt(anim, anim.propertyGroup, pct);
              if (Object.keys(properties).length > 0) {
                void handleGsapAddKeyframeBatch(anim.id, pct, properties, undefined, selection);
              }
            }
          } else {
            const flatAnim = animations.find((a) => !a.keyframes);
            if (flatAnim) {
              void handleGsapConvertToKeyframes(
                flatAnim.id,
                undefined,
                undefined,
                undefined,
                selection,
              );
            }
          }
        });
      },
      onTogglePropertyGroupKeyframe: async (element, target) => {
        const selection = await buildDomSelectionForTimelineElement(element);
        if (!selection) return;
        if (target.remove) {
          removeKeyframeTarget(target.animationId, target.tweenPercentage, selection);
          return;
        }
        await handleGsapAddKeyframeBatch(
          target.animationId,
          target.tweenPercentage,
          target.properties,
          undefined,
          selection,
        );
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      handleTimelineElementMove,
      handleTimelineElementsMove,
      handleTimelineElementResize,
      handleTimelineGroupResize,
      handleToggleTrackHidden,
      setAudioGroupAttribute,
      handleGroupClips,
      setElementFxAttribute,
      handleBlockedTimelineEdit,
      handleTimelineElementSplit,
      handleRazorSplit,
      handleRazorSplitAll,
      handleGsapRemoveAllKeyframes,
      resolveElementAnimations,
      resolveKeyframeTarget,
      removeKeyframeTarget,
      selectedGsapAnimations,
      handleGsapMoveKeyframeToPlayhead,
      handleGsapMoveKeyframe,
      handleGsapResizeKeyframedTween,
      handleGsapUpdateMeta,
      handleGsapAddKeyframeBatch,
      handleGsapConvertToKeyframes,
      buildDomSelectionForTimelineElement,
      projectId,
      activeCompPath,
      domEditSelection,
      nativeProjectDocument,
      deleteNativeKeyframe,
      deleteNativeKeyframes,
      deleteAllNativeKeyframes,
      moveNativeKeyframe,
      moveNativeKeyframes,
      setNativeKeyframeInterpolation,
      setNativeKeyframesInterpolation,
    ],
  );
}
