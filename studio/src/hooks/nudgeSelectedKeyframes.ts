import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import { planKeyframeNudge } from "../components/editor/keyframeNudge";
import {
  timelineKeyframeSelectionKey,
  timelineKeyframeTargetFromSelectionKey,
  type TimelineKeyframeTarget,
} from "../player/components/timelineKeyframeIdentity";
import { usePlayerStore } from "../player/store/playerStore";
import { resolveTweenStart } from "../utils/globalTimeCompiler";
import { resolveEditableTweenDuration, toClipPercentage } from "./gsapShared";
import type { NativeProjectDocument } from "../project/nativeProjectDocument";
import {
  nudgeSelectedKeyframes as nudgeNativeSelectedKeyframes,
} from "../player/components/nudgeSelectedKeyframes";
import {
  nativeParameterAddressKey,
  type NativeKeyframeProjectCommit,
  type NativeSelectedKeyframeAddress,
} from "../player/components/deleteSelectedKeyframes";

export interface NudgeSelectedKeyframesSession {
  domEditSelection: DomEditSelection | null;
  selectedGsapAnimations: readonly GsapAnimation[];
  handleGsapMoveKeyframes?: (
    moves: readonly {
      animationId: string;
      fromPercentage: number;
      toPercentage: number;
    }[],
  ) => Promise<boolean>;
  nativeDocument?: NativeProjectDocument | null;
  commitNativeProject?: (commit: NativeKeyframeProjectCommit) => Promise<boolean>;
}

interface ResolvedSelectedKeyframe {
  selectionKey: string;
  target: TimelineKeyframeTarget;
  animation: GsapAnimation;
  tweenPercentage: number;
}

function hasSameSelection(
  current: ReadonlySet<string>,
  original: ReadonlySet<string>,
): boolean {
  if (current.size !== original.size) return false;
  for (const key of original) {
    if (!current.has(key)) return false;
  }
  return true;
}

function resolveSelectedKeyframes(
  elementId: string,
  selectionKeys: ReadonlySet<string>,
  animations: readonly GsapAnimation[],
): ResolvedSelectedKeyframe[] | null {
  const keyframed = animations.filter((animation) => animation.keyframes);
  const byId = new Map(keyframed.map((animation) => [animation.id, animation]));
  const fallback = keyframed.length === 1 ? keyframed[0] : undefined;
  const resolved: ResolvedSelectedKeyframe[] = [];
  for (const selectionKey of selectionKeys) {
    const target = timelineKeyframeTargetFromSelectionKey(elementId, selectionKey);
    if (!target) return null;
    const animation = target.animationId ? byId.get(target.animationId) : fallback;
    if (!animation) return null;
    const tweenPercentage = target.tweenPercentage ?? target.percentage;
    if (
      !animation.keyframes?.keyframes.some(
        (keyframe) => keyframe.percentage === tweenPercentage,
      )
    ) {
      return null;
    }
    resolved.push({ selectionKey, target, animation, tweenPercentage });
  }
  return resolved;
}

/**
 * Frame-nudge the current element's selected keyframes in one durable batch.
 * One frame is the precise step; Shift requests ten. All animation groups use
 * the tightest safe delta so relative timing remains intact across the entire
 * selection, and UI selection is re-keyed only after the source commit lands.
 */
export async function nudgeSelectedKeyframes(
  session: NudgeSelectedKeyframesSession,
  direction: -1 | 1,
  large: boolean,
): Promise<boolean> {
  const snapshot = usePlayerStore.getState();
  const { selectedElementId, selectedKeyframes } = snapshot;
  const parsedTargets = [...selectedKeyframes].map((key) =>
    timelineKeyframeTargetFromSelectionKey(selectedElementId ?? "", key),
  );
  const nativeTargetGroups = parsedTargets.map((target) =>
    target?.nativeTargets?.length
      ? target.nativeTargets
      : target?.native
        ? [target.native]
        : [],
  );
  const nativeTargets = nativeTargetGroups.flatMap((targets): NativeSelectedKeyframeAddress[] =>
    targets.map((target) => ({
          address: {
            sequenceId: target.sequenceId,
            trackId: target.trackId,
            clipId: target.clipId,
            parameterId: target.parameterId,
          },
          frame: target.frame,
        })),
  );
  if (nativeTargets.length > 0) {
    if (nativeTargetGroups.some((targets) => targets.length === 0) || !selectedElementId) {
      return false;
    }
    const originalSelection = selectedKeyframes;
    const committedNativeSelection: {
      value: readonly NativeSelectedKeyframeAddress[] | null;
    } = { value: null };
    const succeeded = await nudgeNativeSelectedKeyframes(
      {
        nativeDocument: session.nativeDocument,
        nativeSelection: nativeTargets,
        commitNativeProject: session.commitNativeProject,
        onNativeSelectionCommitted: (nextSelection) => {
          committedNativeSelection.value = nextSelection;
        },
        nudgeLegacySelectedKeyframes: async () => false,
      },
      direction,
      large,
    );
    if (!succeeded) return false;
    const current = usePlayerStore.getState();
    if (
      current.selectedElementId !== selectedElementId ||
      !hasSameSelection(current.selectedKeyframes, originalSelection)
    ) {
      return true;
    }
    const movedSelection = committedNativeSelection.value;
    if (!movedSelection || movedSelection.length !== nativeTargets.length) {
      return false;
    }
    const movedFrames = new Map(
      nativeTargets.map((selected, index) => [
        `${nativeParameterAddressKey(selected.address)}\0${selected.frame}`,
        movedSelection[index]!.frame,
      ]),
    );
    const movedFrame = (target: NonNullable<TimelineKeyframeTarget["native"]>) =>
      movedFrames.get(
        `${nativeParameterAddressKey({
          sequenceId: target.sequenceId,
          trackId: target.trackId,
          clipId: target.clipId,
          parameterId: target.parameterId,
        })}\0${target.frame}`,
      );
    const nextSelection = new Set<string>();
    for (const target of parsedTargets) {
      if (!target?.native) return false;
      const nextFrame = movedFrame(target.native);
      if (nextFrame === undefined) return false;
      const clip = session.nativeDocument?.sequence.tracks
        .find((track) => track.id === target.native!.trackId)
        ?.clips.find((candidate) => candidate.id === target.native!.clipId);
      if (!clip) return false;
      const nextNativeTargets = target.nativeTargets?.map((nativeTarget) => {
        const frame = movedFrame(nativeTarget);
        return frame === undefined ? null : { ...nativeTarget, frame };
      });
      if (nextNativeTargets?.some((nativeTarget) => nativeTarget === null)) return false;
      nextSelection.add(
        timelineKeyframeSelectionKey(selectedElementId, {
          ...target,
          percentage: (nextFrame / clip.durationFrames) * 100,
          tweenPercentage: (nextFrame / clip.durationFrames) * 100,
          native: { ...target.native, frame: nextFrame },
          ...(nextNativeTargets
            ? { nativeTargets: nextNativeTargets as NonNullable<typeof target.nativeTargets> }
            : {}),
        }),
      );
    }
    usePlayerStore.setState({ selectedKeyframes: nextSelection });
    return true;
  }
  const selection = session.domEditSelection;
  if (!session.handleGsapMoveKeyframes) return false;
  if (!selection || !selectedElementId || selectedKeyframes.size === 0) return false;

  const resolved = resolveSelectedKeyframes(
    selectedElementId,
    selectedKeyframes,
    session.selectedGsapAnimations,
  );
  if (!resolved || resolved.length === 0) return false;

  const byAnimation = new Map<string, ResolvedSelectedKeyframe[]>();
  for (const item of resolved) {
    const group = byAnimation.get(item.animation.id) ?? [];
    group.push(item);
    byAnimation.set(item.animation.id, group);
  }

  const requestedFrameCount = large ? 10 : 1;
  const initialPlans = [...byAnimation.values()].map((group) => {
    const animation = group[0]!.animation;
    return {
      group,
      start:
        resolveTweenStart(animation) ??
        (Number.parseFloat(selection.dataAttributes?.start ?? "0") || 0),
      duration: resolveEditableTweenDuration(animation, selection),
    };
  });
  const bounded = initialPlans.map((entry) => ({
    ...entry,
    plan: planKeyframeNudge({
      keyframePercentages:
        entry.group[0]!.animation.keyframes?.keyframes.map((keyframe) => keyframe.percentage) ?? [],
      selectedPercentages: entry.group.map((item) => item.tweenPercentage),
      tweenStart: entry.start,
      tweenDuration: entry.duration,
      direction,
      frameCount: requestedFrameCount,
    }),
  }));
  if (bounded.some(({ plan }) => plan.kind !== "move")) return false;
  const sharedFrameCount = Math.min(...bounded.map(({ plan }) => Math.abs(plan.deltaFrames)));
  if (!Number.isFinite(sharedFrameCount) || sharedFrameCount <= 0) return false;

  const finalPlans = bounded.map((entry) => ({
    ...entry,
    plan: planKeyframeNudge({
      keyframePercentages:
        entry.group[0]!.animation.keyframes?.keyframes.map((keyframe) => keyframe.percentage) ?? [],
      selectedPercentages: entry.group.map((item) => item.tweenPercentage),
      tweenStart: entry.start,
      tweenDuration: entry.duration,
      direction,
      frameCount: sharedFrameCount,
    }),
  }));
  if (finalPlans.some(({ plan }) => plan.kind !== "move")) return false;

  const moves = finalPlans.flatMap(({ group, plan }) =>
    (plan.moves ?? []).map((move) => ({
      animationId: group[0]!.animation.id,
      fromPercentage: move.from,
      toPercentage: move.to,
    })),
  );
  let committed = false;
  try {
    committed = await session.handleGsapMoveKeyframes(moves);
  } catch {
    committed = false;
  }
  if (!committed) return false;

  const current = usePlayerStore.getState();
  // A late save must never replace a newer user selection.
  if (
    current.selectedElementId !== selectedElementId ||
    !hasSameSelection(current.selectedKeyframes, selectedKeyframes)
  ) {
    return true;
  }

  const timelineElement = current.elements.find(
    (element) => (element.key ?? element.id) === selectedElementId,
  );
  const moveByIdentity = new Map(
    moves.map((move) => [`${move.animationId}\0${move.fromPercentage}`, move]),
  );
  const nextSelection = new Set<string>();
  for (const item of resolved) {
    const move = moveByIdentity.get(`${item.animation.id}\0${item.tweenPercentage}`);
    if (!move) return true;
    const tweenStart = resolveTweenStart(item.animation) ?? 0;
    const tweenDuration = resolveEditableTweenDuration(item.animation, selection);
    const absoluteTime = tweenStart + (move.toPercentage / 100) * tweenDuration;
    const clipPercentage = timelineElement
      ? toClipPercentage(
          absoluteTime,
          timelineElement.start,
          timelineElement.duration,
          item.target.percentage,
        )
      : item.target.percentage;
    nextSelection.add(
      timelineKeyframeSelectionKey(selectedElementId, {
        ...item.target,
        percentage: clipPercentage,
        tweenPercentage: move.toPercentage,
      }),
    );
  }
  usePlayerStore.setState({ selectedKeyframes: nextSelection });

  const active = usePlayerStore.getState().activeKeyframeTarget;
  if (active?.elementId === selectedElementId) {
    const activeMove = moves.find(
      (move) =>
        move.animationId === active.animationId &&
        move.fromPercentage === active.tweenPercentage,
    );
    if (activeMove) {
      usePlayerStore.getState().setActiveKeyframeTarget({
        ...active,
        tweenPercentage: activeMove.toPercentage,
      });
    }
  }
  return true;
}
