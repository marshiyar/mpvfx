import { useCallback, type RefObject } from "react";
import type { CommitMutation } from "./gsapScriptCommitTypes";
import type { AnimationKeyframeTarget } from "./gsapTweenSynth";
import type { DomEditSelection } from "../components/editor/domEditing";

interface KeyframeEaseCommitsInput {
  gsapCommitMutation: CommitMutation;
  domEditSelectionRef: RefObject<DomEditSelection | null>;
}

/**
 * Easing controls must never leave a rejected durable write floating in the
 * event loop. The editor only renders parsed source/cache state, so there is no
 * local optimistic ease value to roll back here; callers receive an explicit
 * false result and can keep the existing value visible.
 */
async function settleEaseMutation(write: Promise<void>): Promise<boolean> {
  try {
    await write;
    return true;
  } catch {
    return false;
  }
}

export function useKeyframeEaseCommits({
  gsapCommitMutation,
  domEditSelectionRef,
}: KeyframeEaseCommitsInput) {
  const handleUpdateSegmentEase = useCallback(
    (targets: AnimationKeyframeTarget[], ease: string) => {
      const selection = domEditSelectionRef.current;
      if (!selection || targets.length === 0) return Promise.resolve(false);
      const options = {
        label: targets.length === 1 ? "Update keyframe ease" : "Update segment ease",
        softReload: true,
      };
      const calls = targets.map(({ animationId, tweenPercentage }) => ({
        selection,
        mutation: {
          type: "update-keyframe",
          animationId,
          percentage: tweenPercentage,
          properties: {},
          ease,
        },
        options,
      }));
      if (calls.length === 1) {
        const call = calls[0];
        return call ? settleEaseMutation(gsapCommitMutation(call.selection, call.mutation, call.options)) : Promise.resolve(false);
      }
      const batch = gsapCommitMutation.batch;
      if (batch) {
        // The installed writer applies this request atomically. A rejection
        // therefore leaves both source and the rendered/cache value untouched.
        return settleEaseMutation(batch(calls, options));
      }
      // A wrapped commit (for example a gesture transaction) may not carry the
      // atomic transport. Do not fall back to sequential writes: if a later
      // write rejects, an earlier segment would already have been persisted.
      // Refusing leaves every segment at its existing durable value.
      return Promise.resolve(false);
    },
    [gsapCommitMutation, domEditSelectionRef],
  );

  const handleUpdateKeyframeEase = useCallback(
    (animationId: string, percentage: number, ease: string) =>
      handleUpdateSegmentEase([{ animationId, tweenPercentage: percentage }], ease),
    [handleUpdateSegmentEase],
  );

  const handleSetAllKeyframeEases = useCallback(
    (animationId: string, ease: string) => {
      const sel = domEditSelectionRef.current;
      if (!sel) return;
      // Return the durable writer promise. Callers must not treat dispatch as
      // success: the source write and its single undo entry settle together.
      return settleEaseMutation(
        gsapCommitMutation(
          sel,
          {
            type: "update-meta",
            animationId,
            updates: { easeEach: ease, resetKeyframeEases: true },
          },
          { label: "Apply ease to all segments", softReload: true },
        ),
      );
    },
    [gsapCommitMutation, domEditSelectionRef],
  );

  return { handleUpdateSegmentEase, handleUpdateKeyframeEase, handleSetAllKeyframeEases };
}
