// fallow-ignore-file code-duplication
// Add/remove operation-family transaction shapes stay parallel until SDK graduation.
import { useCallback } from "react";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import type { Composition } from "@hyperframes/sdk";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import {
  sdkGsapKeyframePersist,
  sdkGsapRemoveKeyframePersist,
  sdkGsapRemoveAllKeyframesPersist,
  sdkGsapConvertToKeyframesPersist,
  cutoverCommittedOrThrow,
  type CutoverDeps,
} from "../utils/sdkCutover";
import type { KeyframeCacheEntry } from "../player/store/playerStore";
import { usePlayerStore } from "../player/store/playerStore";
import { commitKeyframeAtTimeImpl } from "./gsapKeyframeCommit";
import { keyframesShareOutputFrame, type KeyframeFrameTiming } from "./gsapShared";
import {
  clearKeyframeCacheForElement,
  readKeyframeSnapshot,
  writeKeyframeCache,
} from "./gsapKeyframeCacheHelpers";
import type {
  CommitMutation,
  CommitMutationOptions,
  SafeGsapCommitMutation,
  TrackGsapSaveFailure,
} from "./gsapScriptCommitTypes";

type OptimisticKeyframeCacheUpdate = {
  apply: (entry: KeyframeCacheEntry) => KeyframeCacheEntry;
  status: "pending" | "succeeded" | "failed";
};

type OptimisticKeyframeCacheJournal = {
  previous: KeyframeCacheEntry | undefined;
  updates: OptimisticKeyframeCacheUpdate[];
};

// Multiple mutations can optimistically edit one cache entry before any durable
// request settles. Each rollback therefore has to rebase the still-pending edits
// on the same original snapshot; restoring only its own snapshot can resurrect a
// sibling's optimistic removal or leave a ghost deletion behind.
const optimisticKeyframeCacheJournals = new Map<string, OptimisticKeyframeCacheJournal>();

function optimisticKeyframeCacheJournalKey(sourceFile: string, elementId: string): string {
  return `${sourceFile}\0${elementId}`;
}

function projectedKeyframeCacheEntry(journal: OptimisticKeyframeCacheJournal) {
  if (!journal.previous) return undefined;
  return journal.updates.reduce<KeyframeCacheEntry>(
    (entry, update) => (update.status === "failed" ? entry : update.apply(entry)),
    journal.previous,
  );
}

function executeOptimisticKeyframeCacheUpdate(options: {
  sourceFile: string;
  elementId: string | null | undefined;
  apply: (entry: KeyframeCacheEntry) => KeyframeCacheEntry;
  persist: () => Promise<void>;
}): Promise<void> {
  if (!options.elementId) return options.persist();
  const key = optimisticKeyframeCacheJournalKey(options.sourceFile, options.elementId);
  let journal = optimisticKeyframeCacheJournals.get(key);
  if (!journal) {
    journal = { previous: readKeyframeSnapshot(options.sourceFile, options.elementId), updates: [] };
    optimisticKeyframeCacheJournals.set(key, journal);
  }
  const update: OptimisticKeyframeCacheUpdate = { apply: options.apply, status: "pending" };
  journal.updates.push(update);
  writeKeyframeCache(options.sourceFile, options.elementId, projectedKeyframeCacheEntry(journal));

  const settle = (status: OptimisticKeyframeCacheUpdate["status"]) => {
    update.status = status;
    writeKeyframeCache(options.sourceFile, options.elementId, projectedKeyframeCacheEntry(journal));
    if (!journal!.updates.some((candidate) => candidate.status === "pending")) {
      optimisticKeyframeCacheJournals.delete(key);
    }
  };
  return options.persist().then(
    () => settle("succeeded"),
    (error: unknown) => {
      settle("failed");
      // Keyframe commands report their own save failures and return an explicit
      // settlement result. Swallowing here makes a rejected durable write look
      // successful to a multi-key deletion and clears its UI selection.
      throw error;
    },
  );
}

type CachedKeyframe = KeyframeCacheEntry["keyframes"][number];

function keyframeTargets(keyframe: CachedKeyframe) {
  if (keyframe.collidingAnimationTargets?.length) return keyframe.collidingAnimationTargets;
  return keyframe.animationId === undefined || keyframe.tweenPercentage === undefined
    ? []
    : [{ animationId: keyframe.animationId, tweenPercentage: keyframe.tweenPercentage }];
}

function exactTargetMatch(
  target: { animationId: string; tweenPercentage: number },
  animationId: string,
  tweenPercentage: number,
): boolean {
  return target.animationId === animationId && target.tweenPercentage === tweenPercentage;
}

/**
 * A legacy row has no source pair to match exactly. It may still be compared
 * on Studio's rendered clock, but only when the target tween supplies a real
 * duration; otherwise an exact percentage is the only honest identity.
 */
function sourceAnimationTiming(animation: GsapAnimation | undefined): KeyframeFrameTiming {
  if (!animation || !Number.isFinite(animation.duration) || (animation.duration ?? 0) <= 0) return {};
  return {
    start: animation.resolvedStart ?? (typeof animation.position === "number" ? animation.position : 0),
    duration: animation.duration,
  };
}

function legacyKeyframeMatches(
  keyframe: CachedKeyframe,
  animationId: string,
  percentage: number,
  sourceAnimations: GsapAnimation[],
): boolean {
  return keyframesShareOutputFrame(
    keyframe.tweenPercentage ?? keyframe.percentage,
    percentage,
    sourceAnimationTiming(sourceAnimations.find((animation) => animation.id === animationId)),
  );
}

function keyframeMatchesTarget(
  keyframe: CachedKeyframe,
  animationId: string,
  percentage: number,
  sourceAnimations: GsapAnimation[],
): boolean {
  const targets = keyframeTargets(keyframe);
  return targets.length > 0
    ? targets.some((target) => exactTargetMatch(target, animationId, percentage))
    : legacyKeyframeMatches(keyframe, animationId, percentage, sourceAnimations);
}

/**
 * Rebuild a merged cache row from its surviving source tweens. The collapsed
 * cache combines properties that may belong to different animations, so a
 * percentage-only removal must not drop the entire row when just one source
 * tween owns the requested keyframe.
 */
function rebuildCollidingKeyframe(
  keyframe: CachedKeyframe,
  targets: ReturnType<typeof keyframeTargets>,
  sourceAnimations: GsapAnimation[],
): CachedKeyframe | null {
  const sourcedTargets = targets.map((target) => {
    const animation = sourceAnimations.find((candidate) => candidate.id === target.animationId);
    const sourceKeyframe = animation?.keyframes?.keyframes.find(
      (candidate) => candidate.percentage === target.tweenPercentage,
    );
    return { target, animation, sourceKeyframe };
  });
  // A stale/incomplete source cache cannot tell which merged properties belonged
  // to which tween. Keep the visible row until the authoritative reload rather
  // than accidentally hiding a sibling animation.
  if (sourcedTargets.some(({ animation, sourceKeyframe }) => !animation || !sourceKeyframe)) return null;

  const first = sourcedTargets[0]!;
  const rebuilt: CachedKeyframe = {
    percentage: keyframe.percentage,
    tweenPercentage: first.target.tweenPercentage,
    animationId: first.target.animationId,
    properties: Object.assign({}, ...sourcedTargets.map(({ sourceKeyframe }) => sourceKeyframe!.properties)),
  };
  if (first.animation!.propertyGroup) rebuilt.propertyGroup = first.animation!.propertyGroup;
  if (sourcedTargets.length > 1) rebuilt.collidingAnimationTargets = targets;
  else if (first.sourceKeyframe!.ease) rebuilt.ease = first.sourceKeyframe!.ease;
  return rebuilt;
}

function removeKeyframeFromOptimisticCache(
  entry: KeyframeCacheEntry,
  animationId: string,
  percentage: number,
  sourceAnimations: GsapAnimation[],
): KeyframeCacheEntry {
  const keyframes = entry.keyframes.flatMap((keyframe) => {
      const targets = keyframeTargets(keyframe);
      // Legacy/runtime cache rows have no source identity. Compare their
      // rendered frame only when the target source has valid timing; otherwise
      // exact percentage is the safe compatibility behavior.
      if (targets.length === 0) {
        return legacyKeyframeMatches(keyframe, animationId, percentage, sourceAnimations) ? [] : [keyframe];
      }
      const remaining = targets.filter(
        (target) => !exactTargetMatch(target, animationId, percentage),
      );
      if (remaining.length === targets.length) return [keyframe];
      if (remaining.length === 0) return [];
      return [rebuildCollidingKeyframe(keyframe, remaining, sourceAnimations) ?? keyframe];
    });
  if (
    keyframes.length === entry.keyframes.length &&
    keyframes.every((keyframe, index) => keyframe === entry.keyframes[index])
  ) {
    return entry;
  }
  return { ...entry, keyframes };
}

interface SdkKeyframeDeps {
  sdkSession?: Composition | null;
  sdkDeps?: CutoverDeps | null;
}

interface GsapKeyframeOpsParams extends SdkKeyframeDeps {
  activeCompPath: string | null;
  commitMutation: CommitMutation;
  commitMutationSafely: SafeGsapCommitMutation;
  trackGsapSaveFailure: TrackGsapSaveFailure;
}

/**
 * Translate a gesture's commit overrides into the SDK persist options. The
 * server path's `softReload`/`skipReload` maps to the SDK's `skipRefresh`, and
 * `coalesceKey`/`coalesceMs` must ride along so an SDK-routed edit folds into
 * one undo entry the same way the server path does.
 */
function toSdkPersistOptions(label: string, overrides?: Partial<CommitMutationOptions>) {
  return {
    label,
    coalesceKey: overrides?.coalesceKey,
    coalesceMs: overrides?.coalesceMs,
    skipRefresh: overrides?.skipReload,
  };
}

type KeyframeMove = {
  animationId: string;
  fromPercentage: number;
  toPercentage: number;
};

/**
 * The installed batch writer applies its entries one by one. Moving adjacent
 * keys as a group must therefore vacate a rightward group's tail first and a
 * leftward group's head first. Keep animations in independent, first-seen
 * groups so properties from separate tweens never determine each other's
 * writer order.
 */
function orderKeyframeMovesForSequentialBatch(moves: readonly KeyframeMove[]): KeyframeMove[] {
  const groups = new Map<string, KeyframeMove[]>();
  for (const move of moves) {
    const group = groups.get(move.animationId);
    if (group) group.push(move);
    else groups.set(move.animationId, [move]);
  }

  return [...groups.values()].flatMap((group) => {
    const rightward = group
      .filter((move) => move.toPercentage > move.fromPercentage)
      .sort((left, right) => right.fromPercentage - left.fromPercentage);
    const stationary = group.filter((move) => move.toPercentage === move.fromPercentage);
    const leftward = group
      .filter((move) => move.toPercentage < move.fromPercentage)
      .sort((left, right) => left.fromPercentage - right.fromPercentage);
    return [...rightward, ...stationary, ...leftward];
  });
}

export function useGsapKeyframeOps({
  activeCompPath,
  commitMutation,
  commitMutationSafely,
  trackGsapSaveFailure,
  sdkSession,
  sdkDeps,
}: GsapKeyframeOpsParams) {
  const addKeyframe = useCallback(
    (
      selection: DomEditSelection,
      animationId: string,
      percentage: number,
      property: string,
      value: number | string,
    ) => {
      const sourceFile = selection.sourceFile || activeCompPath || "index.html";
      const mutation = {
        type: "add-keyframe",
        animationId,
        percentage,
        properties: { [property]: value },
      };
      const sourceAnimations = selection.id
        ? usePlayerStore.getState().gsapAnimations.get(`${sourceFile}#${selection.id}`) ?? []
        : [];
      void executeOptimisticKeyframeCacheUpdate({
        sourceFile,
        elementId: selection.id,
        apply: (prev) => {
          // A source animation + tween percentage is an exact identity. For a
          // collapsed collision row, that pair can belong to a secondary tween
          // rather than the row's primary fields, so inspect every target before
          // appending. Legacy rows get the frame-aware fallback in
          // keyframeMatchesTarget instead of a percentage tolerance.
          const idx = prev.keyframes.findIndex(
            (keyframe) => keyframeMatchesTarget(keyframe, animationId, percentage, sourceAnimations),
          );
          if (idx >= 0) {
            const keyframes = prev.keyframes.slice();
            const current = keyframes[idx]!;
            const targets = keyframeTargets(current);
            // Reconstruct a collapsed row from every source target when we can,
            // then overlay the optimistic property. This keeps the primary and
            // secondary identities intact for the next edit; an incomplete
            // source cache deliberately retains the current row until reload.
            const rebuilt =
              targets.length > 1
                ? rebuildCollidingKeyframe(current, targets, sourceAnimations) ?? current
                : current;
            keyframes[idx] = {
              ...rebuilt,
              properties: { ...rebuilt.properties, ...current.properties, [property]: value },
            };
            return { ...prev, keyframes };
          }
          return {
            ...prev,
            keyframes: [...prev.keyframes, { percentage, properties: { [property]: value } }].sort(
              (a, b) => a.percentage - b.percentage,
            ),
          };
        },
        persist: async () => {
          if (sdkSession && sdkDeps) {
            const handled = await sdkGsapKeyframePersist(
              sourceFile,
              animationId,
              percentage,
              { [property]: value },
              sdkSession,
              sdkDeps,
              {
                label: `Add keyframe at ${percentage}%`,
                coalesceKey: `gsap:${animationId}:kf:${percentage}`,
              },
            );
            if (cutoverCommittedOrThrow(handled)) return;
          }
          await commitMutation(selection, mutation, {
            label: `Add keyframe at ${percentage}%`,
            softReload: true,
          });
        },
      }).catch((error) => {
        trackGsapSaveFailure(error, selection, mutation, `Add keyframe at ${percentage}%`);
      });
    },
    [activeCompPath, commitMutation, trackGsapSaveFailure, sdkSession, sdkDeps],
  );

  const addKeyframeBatch = useCallback(
    async (
      selection: DomEditSelection,
      animationId: string,
      percentage: number,
      properties: Record<string, number | string>,
      commitOverrides?: Partial<CommitMutationOptions>,
    ) => {
      if (sdkSession && sdkDeps) {
        const sourceFile = selection.sourceFile || activeCompPath || "index.html";
        const handled = await sdkGsapKeyframePersist(
          sourceFile,
          animationId,
          percentage,
          properties,
          sdkSession,
          sdkDeps,
          toSdkPersistOptions(`Add keyframe at ${percentage}%`, commitOverrides),
        );
        if (cutoverCommittedOrThrow(handled)) return;
      }
      return commitMutation(
        selection,
        { type: "add-keyframe", animationId, percentage, properties },
        {
          label: `Add keyframe at ${percentage}%`,
          softReload: true,
          ...commitOverrides,
        },
      );
    },
    [commitMutation, activeCompPath, sdkSession, sdkDeps],
  );

  const removeKeyframe = useCallback(
    async (
      selection: DomEditSelection,
      animationId: string,
      percentage: number,
      commitOverrides?: Partial<CommitMutationOptions>,
    ): Promise<boolean> => {
      const sourceFile = selection.sourceFile || activeCompPath || "index.html";
      const mutation = { type: "remove-keyframe", animationId, percentage };
      const sourceAnimations = selection.id
        ? usePlayerStore.getState().gsapAnimations.get(`${sourceFile}#${selection.id}`) ?? []
        : [];
      try {
        await executeOptimisticKeyframeCacheUpdate({
          sourceFile,
          elementId: selection.id,
          // Respect the exact source pair when it is available, including
          // every source in a collapsed collision row. Legacy rows fall back
          // to their valid rendered-frame identity only.
          apply: (prev) =>
            removeKeyframeFromOptimisticCache(prev, animationId, percentage, sourceAnimations),
          persist: async () => {
            const label = `Remove keyframe at ${percentage}%`;
            if (sdkSession && sdkDeps) {
              const handled = await sdkGsapRemoveKeyframePersist(
                sourceFile,
                animationId,
                percentage,
                sdkSession,
                sdkDeps,
                toSdkPersistOptions(label, commitOverrides),
              );
              if (cutoverCommittedOrThrow(handled)) return;
            }
            const commitOptions = commitOverrides?.skipReload
              ? { label, ...commitOverrides }
              : { label, softReload: true, ...commitOverrides };
            await commitMutation(selection, mutation, commitOptions);
          },
        });
        return true;
      } catch (error) {
        trackGsapSaveFailure(error, selection, mutation, `Remove keyframe at ${percentage}%`);
        return false;
      }
    },
    [activeCompPath, commitMutation, trackGsapSaveFailure, sdkSession, sdkDeps],
  );

  const removeKeyframes = useCallback(
    async (
      selection: DomEditSelection,
      requestedTargets: readonly { animationId: string; percentage: number }[],
      commitOverrides?: Partial<CommitMutationOptions>,
    ): Promise<boolean> => {
      const targets = [
        ...new Map(
          requestedTargets.map((target) => [
            `${target.animationId}\0${target.percentage}`,
            target,
          ]),
        ).values(),
      ];
      if (targets.length === 0) return false;
      if (targets.length === 1) {
        const target = targets[0]!;
        return removeKeyframe(selection, target.animationId, target.percentage, commitOverrides);
      }

      const label = `Remove ${targets.length} keyframes`;
      const mutation = { type: "remove-keyframes", targets };
      // The SDK helpers currently expose one removal at a time. Never emulate
      // atomicity by issuing them sequentially: a later failure would leave an
      // earlier keyframe durably gone while the UI reports the action failed.
      if (sdkSession && sdkDeps) {
        const error = new Error("Atomic keyframe deletion is unavailable for this SDK session");
        trackGsapSaveFailure(error, selection, mutation, label);
        return false;
      }
      const batch = commitMutation.batch;
      if (!batch) {
        const error = new Error("Atomic keyframe deletion is unavailable");
        trackGsapSaveFailure(error, selection, mutation, label);
        return false;
      }

      const sourceFile = selection.sourceFile || activeCompPath || "index.html";
      const sourceAnimations = selection.id
        ? usePlayerStore.getState().gsapAnimations.get(`${sourceFile}#${selection.id}`) ?? []
        : [];
      try {
        await executeOptimisticKeyframeCacheUpdate({
          sourceFile,
          elementId: selection.id,
          apply: (previous) =>
            targets.reduce(
              (entry, target) =>
                removeKeyframeFromOptimisticCache(
                  entry,
                  target.animationId,
                  target.percentage,
                  sourceAnimations,
                ),
              previous,
            ),
          persist: () =>
            batch(
              targets.map((target) => ({
                selection,
                mutation: {
                  type: "remove-keyframe",
                  animationId: target.animationId,
                  percentage: target.percentage,
                },
                options: { label: `Remove keyframe at ${target.percentage}%` },
              })),
              { label, softReload: true, ...commitOverrides },
            ),
        });
        return true;
      } catch (error) {
        trackGsapSaveFailure(error, selection, mutation, label);
        return false;
      }
    },
    [activeCompPath, commitMutation, removeKeyframe, sdkSession, sdkDeps, trackGsapSaveFailure],
  );

  const moveKeyframe = useCallback(
    async (
      selection: DomEditSelection,
      animationId: string,
      fromPercentage: number,
      toPercentage: number,
    ) => {
      const mutation = { type: "move-keyframe", animationId, fromPercentage, toPercentage };
      // No SDK persist helper exists for retime — server path only. The post-commit
      // updateKeyframeCacheFromParsed re-keys the diamond from the fresh parse, so no
      // optimistic cache write is needed (mapping the tween-% to clip-% here would
      // duplicate that math). softReload mirrors remove-keyframe.
      try {
        let changed = false;
        await commitMutation(selection, mutation, {
          label: `Move keyframe to ${toPercentage}%`,
          softReload: true,
          onResult: (result) => {
            changed = result.changed !== false;
          },
        });
        return changed;
      } catch (error) {
        trackGsapSaveFailure(error, selection, mutation, `Move keyframe to ${toPercentage}%`);
        return false;
      }
    },
    [commitMutation, trackGsapSaveFailure],
  );

  const moveKeyframes = useCallback(
    async (
      selection: DomEditSelection,
      requestedMoves: readonly {
        animationId: string;
        fromPercentage: number;
        toPercentage: number;
      }[],
    ): Promise<boolean> => {
      const moves = [
        ...new Map(
          requestedMoves.map((move) => [
            `${move.animationId}\0${move.fromPercentage}`,
            move,
          ]),
        ).values(),
      ];
      if (moves.length === 0) return false;
      if (moves.length === 1) {
        const move = moves[0]!;
        return moveKeyframe(
          selection,
          move.animationId,
          move.fromPercentage,
          move.toPercentage,
        );
      }

      const label = `Move ${moves.length} keyframes`;
      const mutation = { type: "move-keyframes", targets: moves };
      const orderedMoves = orderKeyframeMovesForSequentialBatch(moves);
      const batch = commitMutation.batch;
      if (!batch) {
        const error = new Error("Atomic keyframe retiming is unavailable");
        trackGsapSaveFailure(error, selection, mutation, label);
        return false;
      }

      try {
        let changed = false;
        await batch(
          orderedMoves.map((move) => ({
            selection,
            mutation: { type: "move-keyframe", ...move },
            options: { label: `Move keyframe to ${move.toPercentage}%` },
          })),
          {
            label,
            softReload: true,
            onResult: (result) => {
              changed = result.changed !== false;
            },
          },
        );
        return changed;
      } catch (error) {
        trackGsapSaveFailure(error, selection, mutation, label);
        return false;
      }
    },
    [commitMutation, moveKeyframe, trackGsapSaveFailure],
  );

  const resizeKeyframedTween = useCallback(
    async (
      selection: DomEditSelection,
      animationId: string,
      position: number,
      duration: number,
      pctRemap: Array<{ from: number; to: number }>,
    ) => {
      const mutation = {
        type: "resize-keyframed-tween",
        animationId,
        position,
        duration,
        pctRemap,
      };
      // Boundary drag-to-retime: the server re-keys keyframes in place + grows the
      // tween window, preserving _auto / per-keyframe ease / easeEach / outer ease.
      // softReload re-keys the diamonds from the fresh parse (mirrors moveKeyframe).
      try {
        let changed = false;
        await commitMutation(selection, mutation, {
          label: "Retime keyframe (resize tween)",
          softReload: true,
          onResult: (result) => {
            changed = result.changed !== false;
          },
        });
        return changed;
      } catch (error) {
        trackGsapSaveFailure(error, selection, mutation, "Retime keyframe (resize tween)");
        return false;
      }
    },
    [commitMutation, trackGsapSaveFailure],
  );

  const convertToKeyframes = useCallback(
    async (
      selection: DomEditSelection,
      animationId: string,
      resolvedFromValues?: Record<string, number | string>,
      duration?: number,
      commitOverrides: Partial<CommitMutationOptions> = { softReload: true },
    ) => {
      if (sdkSession && sdkDeps) {
        const targetPath = selection.sourceFile || activeCompPath || "index.html";
        const handled = await sdkGsapConvertToKeyframesPersist(
          targetPath,
          animationId,
          resolvedFromValues,
          sdkSession,
          sdkDeps,
          toSdkPersistOptions("Convert to keyframes", commitOverrides),
        );
        if (cutoverCommittedOrThrow(handled)) return;
      }
      return commitMutation(
        selection,
        // `duration` only applies when the target is a static `set` (which has
        // none) — it spans the converted keyframes across the element's clip.
        { type: "convert-to-keyframes", animationId, resolvedFromValues, duration },
        { label: "Convert to keyframes", ...commitOverrides },
      );
    },
    [commitMutation, activeCompPath, sdkSession, sdkDeps],
  );

  const removeAllKeyframes = useCallback(
    async (
      selection: DomEditSelection,
      animationId: string,
      commitOverrides?: Partial<CommitMutationOptions>,
    ): Promise<boolean> => {
      const targetPath = selection.sourceFile || activeCompPath || "index.html";
      // A class/descendant selector can resolve a live element whose selection
      // deliberately has no id. The cache is still keyed by that DOM id.
      const cacheElementId = selection.id || selection.element?.id;
      try {
        if (sdkSession && sdkDeps) {
          const handled = await sdkGsapRemoveAllKeyframesPersist(
            targetPath,
            animationId,
            sdkSession,
            sdkDeps,
            toSdkPersistOptions("Remove all keyframes", commitOverrides),
          );
          if (cutoverCommittedOrThrow(handled)) {
            if (cacheElementId) clearKeyframeCacheForElement(targetPath, cacheElementId);
            return true;
          }
        }
        await commitMutation(
          selection,
          { type: "remove-all-keyframes", animationId },
          {
            label: "Remove all keyframes",
            softReload: true,
            ...commitOverrides,
            // The committed result is the single success boundary: clearing
            // before it makes failed saves lie, while waiting for the reload leaves
            // stale diamonds visible during the source round-trip.
            onResult: (result) => {
              if (result.changed !== false && cacheElementId) {
                clearKeyframeCacheForElement(targetPath, cacheElementId);
              }
            },
          },
        );
        return true;
      } catch (error) {
        trackGsapSaveFailure(
          error,
          selection,
          { type: "remove-all-keyframes", animationId },
          "Remove all keyframes",
        );
        return false;
      }
    },
    [commitMutation, activeCompPath, sdkSession, sdkDeps, trackGsapSaveFailure],
  );

  const removeAllKeyframesBatch = useCallback(
    async (
      selection: DomEditSelection,
      requestedAnimationIds: readonly string[],
      commitOverrides?: Partial<CommitMutationOptions>,
    ): Promise<boolean> => {
      const animationIds = [...new Set(requestedAnimationIds)];
      if (animationIds.length === 0) return false;
      if (animationIds.length === 1) {
        return removeAllKeyframes(selection, animationIds[0]!, commitOverrides);
      }

      const label = "Remove all keyframes";
      const mutation = { type: "remove-all-keyframes", animationIds };
      // Keep the reset source-atomic. The SDK surface has only the singular
      // remove-all operation, and sequentially applying it can durably reset
      // half a layer before a later request rejects.
      if (sdkSession && sdkDeps) {
        const error = new Error("Atomic keyframe reset is unavailable for this SDK session");
        trackGsapSaveFailure(error, selection, mutation, label);
        return false;
      }
      const batch = commitMutation.batch;
      if (!batch) {
        const error = new Error("Atomic keyframe reset is unavailable");
        trackGsapSaveFailure(error, selection, mutation, label);
        return false;
      }

      const targetPath = selection.sourceFile || activeCompPath || "index.html";
      const cacheElementId = selection.id || selection.element?.id;
      try {
        await batch(
          animationIds.map((animationId) => ({
            selection,
            mutation: { type: "remove-all-keyframes", animationId },
            options: { label },
          })),
          {
            label,
            softReload: true,
            ...commitOverrides,
            onResult: (result) => {
              if (result.changed !== false && cacheElementId) {
                clearKeyframeCacheForElement(targetPath, cacheElementId);
              }
            },
          },
        );
        return true;
      } catch (error) {
        trackGsapSaveFailure(error, selection, mutation, label);
        return false;
      }
    },
    [activeCompPath, commitMutation, removeAllKeyframes, sdkSession, sdkDeps, trackGsapSaveFailure],
  );

  const commitKeyframeAtTime = useCallback(
    (
      selection: DomEditSelection,
      absoluteTime: number,
      animations: GsapAnimation[],
      properties: Record<string, number | string>,
    ) => commitKeyframeAtTimeImpl(selection, absoluteTime, animations, properties, commitMutation),
    [commitMutation],
  );

  return {
    addKeyframe,
    addKeyframeBatch,
    removeKeyframe,
    removeKeyframes,
    moveKeyframe,
    moveKeyframes,
    resizeKeyframedTween,
    convertToKeyframes,
    removeAllKeyframes,
    removeAllKeyframesBatch,
    commitKeyframeAtTime,
  };
}
