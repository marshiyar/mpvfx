import { useEffect, useRef } from "react";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import { usePlayerStore } from "../store/playerStore";
import { useStudioShellContextOptional } from "../../contexts/StudioContext";
import { animationContributesLane } from "./TimelinePropertyLanes";

/**
 * Keyframed clips start expanded (AE/Figma default). Auto-expands each clip the
 * first time it contributes a lane — real keyframes OR a synthesizable flat tween
 * — tracked per-clip so a later user collapse sticks and never bounces back open
 * (and clips added later still auto-expand).
 */
/**
 * Prunes clips that left the source, then returns the ones that newly contribute
 * a lane. The prune matters because the set is otherwise append-only: a clip
 * deleted and reinserted under the same id (undo, paste) would be remembered as
 * already-expanded and never auto-expand again.
 */
function freshLaneClips(
  gsapAnimations: Map<string, GsapAnimation[]>,
  nativeLaneCounts: ReadonlyMap<string, number>,
  clips: Set<string>,
) {
  const active = new Set<string>();
  for (const [key, animations] of gsapAnimations) {
    if (animations.some(animationContributesLane)) active.add(key);
  }
  for (const [key, count] of nativeLaneCounts) {
    if (count > 0) active.add(key);
  }
  for (const key of clips) {
    if (!active.has(key)) clips.delete(key);
  }
  const fresh: string[] = [];
  for (const key of active) {
    if (clips.has(key)) continue;
    fresh.push(key);
  }
  return fresh;
}

const EMPTY_NATIVE_LANE_COUNTS: ReadonlyMap<string, number> = new Map();

export function useAutoExpandKeyframedClips(
  gsapAnimations: Map<string, GsapAnimation[]>,
  nativeLaneCounts: ReadonlyMap<string, number> = EMPTY_NATIVE_LANE_COUNTS,
): void {
  const expandClips = usePlayerStore((s) => s.expandClips);
  const projectId = useStudioShellContextOptional()?.projectId ?? null;
  const seen = useRef({
    projectId,
    source: gsapAnimations,
    nativeSource: nativeLaneCounts,
    clips: new Set<string>(),
  });
  useEffect(() => {
    if (seen.current.projectId !== projectId) {
      const sourceChanged =
        seen.current.source !== gsapAnimations ||
        (seen.current.nativeSource !== nativeLaneCounts &&
          (seen.current.nativeSource.size > 0 || nativeLaneCounts.size > 0));
      seen.current = {
        projectId,
        source: gsapAnimations,
        nativeSource: nativeLaneCounts,
        clips: new Set(),
      };
      if (!sourceChanged) return;
    } else {
      seen.current.source = gsapAnimations;
      seen.current.nativeSource = nativeLaneCounts;
    }
    const fresh = freshLaneClips(gsapAnimations, nativeLaneCounts, seen.current.clips);
    if (fresh.length === 0) return;
    for (const key of fresh) seen.current.clips.add(key);
    expandClips(fresh);
  }, [gsapAnimations, nativeLaneCounts, expandClips, projectId]);
}
