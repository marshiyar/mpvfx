import type { TimelineElement } from "../store/playerStore";
import { classifyZone } from "./timelineZones";
import { computeStackingPatches } from "./timelineStackingSync";
import type { DragCommitDeps } from "./timelineClipDragCommit";

export const keyOf = (element: TimelineElement) => element.key ?? element.id;

/**
 * Compute + apply z-index patches for the edited clip(s) after a DELIBERATE
 * vertical lane change. Projects the drop-intent element set (`candidate`: the
 * dragged clip at its new / fractional-insert lane, others at their current tracks)
 * onto StackingElement using the caller-supplied live z-index reader, then
 * delegates the minimal-z resolution to computeStackingPatches — a clip on the
 * upper lane paints above every clip it time-overlaps. No-op unless both z-sync
 * deps are present, and never when the gesture aimed at the clip's OWN current
 * lane (`aimedLane === currentLane` — not a relocation).
 */
export function syncStackingForEdit(
  candidate: TimelineElement[],
  dragKey: string,
  currentLane: number,
  aimedLane: number,
  multiKeys: ReadonlySet<string> | null,
  deps: DragCommitDeps,
  coalesceKey?: string,
): Promise<void> {
  const { readZIndex, onStackingPatches } = deps;
  if (!readZIndex || !onStackingPatches) return Promise.resolve();

  // Aiming at the clip's OWN current display lane is not a relocation — never
  // touch z (guards the pure-time-move invariant even if a spurious topology call
  // slips through). Every real lane-realization drop aims at a DIFFERENT lane.
  if (aimedLane === currentLane) return Promise.resolve();

  // Discovery order is DOM order, which breaks equal-z ties.
  const stackingEls = candidate.map((el, domIndex) => ({
    key: keyOf(el),
    start: el.start,
    duration: el.duration,
    track: el.track,
    zIndex: readZIndex(el),
    isAudio: classifyZone(el) === "audio",
    sourceFile: el.sourceFile,
    domIndex,
    stackingContextId: el.stackingContextId ?? null,
  }));

  const editedKeys = [dragKey];
  if (multiKeys) for (const k of multiKeys) if (k !== dragKey) editedKeys.push(k);

  const patches = computeStackingPatches(stackingEls, editedKeys);
  if (patches.length === 0) return Promise.resolve();
  return Promise.resolve(onStackingPatches(patches, coalesceKey)).then(() => undefined);
}
