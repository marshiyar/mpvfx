import { usePlayerStore } from "../player/store/playerStore";
import { timelineKeyframeTargetFromSelectionKey } from "../player/components/timelineKeyframeIdentity";
import type { CommitMutationOptions } from "./gsapScriptCommitTypes";
import type { NativeProjectDocument } from "../project/nativeProjectDocument";
import {
  deleteSelectedKeyframes as deleteNativeSelectedKeyframes,
  type NativeKeyframeProjectCommit,
  type NativeSelectedKeyframeAddress,
} from "../player/components/deleteSelectedKeyframes";

let deleteKeyframesCommitCounter = 0;

/**
 * Remove the keyframes currently selected in the player store from the active
 * element's GSAP animation. Reads selection lazily so it stays correct when
 * invoked from a ref callback.
 */
export function deleteSelectedKeyframes(session: {
  selectedGsapAnimations: readonly { id: string; keyframes?: unknown }[];
  handleGsapRemoveKeyframes: (
    targets: readonly { animationId: string; percentage: number }[],
    options?: Partial<CommitMutationOptions>,
  ) => Promise<boolean>;
  nativeDocument?: NativeProjectDocument | null;
  commitNativeProject?: (commit: NativeKeyframeProjectCommit) => Promise<boolean>;
}): Promise<boolean> {
  const { selectedKeyframes, selectedElementId } = usePlayerStore.getState();
  if (!selectedElementId) return Promise.resolve(false);
  const parsedTargets = [...selectedKeyframes].map((key) =>
    timelineKeyframeTargetFromSelectionKey(selectedElementId, key),
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
    // A mixed native/legacy selection is ambiguous. Never partially delete or
    // fall through to GSAP when a native selection is present.
    if (nativeTargetGroups.some((targets) => targets.length === 0)) {
      return Promise.resolve(false);
    }
    return deleteNativeSelectedKeyframes({
      nativeDocument: session.nativeDocument,
      nativeSelection: nativeTargets,
      commitNativeProject: session.commitNativeProject,
      deleteLegacySelectedKeyframes: async () => false,
    }).then((succeeded) => {
      const current = usePlayerStore.getState();
      if (
        succeeded &&
        current.selectedElementId === selectedElementId &&
        current.selectedKeyframes === selectedKeyframes
      ) {
        current.clearSelectedKeyframes();
      }
      return succeeded;
    });
  }
  const keyframedAnimations = session.selectedGsapAnimations.filter((anim) => anim.keyframes);
  // A collapsed selection key (an ungrouped animation) carries no animation id,
  // so it only resolves when there is exactly one keyframed animation it could
  // mean. Taking the first of several deletes an arbitrary tween's keyframe.
  const fallbackAnimation = keyframedAnimations.length === 1 ? keyframedAnimations[0] : undefined;
  const animationsById = new Map(keyframedAnimations.map((animation) => [animation.id, animation]));
  const removals = new Map<string, { animationId: string; percentage: number }>();
  for (const key of selectedKeyframes) {
    const target = timelineKeyframeTargetFromSelectionKey(selectedElementId, key);
    if (!target) continue;
    const animation = target.animationId
      ? animationsById.get(target.animationId)
      : fallbackAnimation;
    if (!animation) continue;
    const percentage = target.tweenPercentage ?? target.percentage;
    removals.set(`${animation.id}\0${percentage}`, { animationId: animation.id, percentage });
  }
  const targets = [...removals.values()];
  if (targets.length === 0) return Promise.resolve(false);
  const coalesceOptions = {
    coalesceKey: `delete-keyframes:${++deleteKeyframesCommitCounter}`,
    coalesceMs: Number.POSITIVE_INFINITY,
  };
  return session.handleGsapRemoveKeyframes(targets, {
    ...coalesceOptions,
    softReload: true,
  }).then((succeeded) => {
    // A deletion can finish after the user has selected another diamond. Clear
    // only the exact selection snapshot this request acted on; otherwise a late
    // completion would erase the newer selection.
    const current = usePlayerStore.getState();
    if (
      succeeded &&
      current.selectedElementId === selectedElementId &&
      current.selectedKeyframes === selectedKeyframes
    ) {
      current.clearSelectedKeyframes();
    }
    return succeeded;
  }, () => false);
}
