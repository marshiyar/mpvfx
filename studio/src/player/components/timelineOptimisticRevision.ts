import { usePlayerStore, type TimelineElement } from "../store/playerStore";

type UpdateElement = (key: string, updates: Partial<TimelineElement>) => void;
const revisionsByUpdater = new WeakMap<UpdateElement, Map<string, number>>();

interface TimelineOptimisticGesture {
  sessionEpoch: number;
  revisions: ReadonlyMap<string, number>;
}

export function beginTimelineOptimisticGesture(
  updateElement: UpdateElement,
  keys: readonly string[],
): TimelineOptimisticGesture {
  let revisions = revisionsByUpdater.get(updateElement);
  if (!revisions) {
    revisions = new Map();
    revisionsByUpdater.set(updateElement, revisions);
  }
  const gesture = new Map<string, number>();
  for (const key of keys) {
    const revision = (revisions.get(key) ?? 0) + 1;
    revisions.set(key, revision);
    gesture.set(key, revision);
  }
  return { sessionEpoch: usePlayerStore.getState().timelineSessionEpoch, revisions: gesture };
}

export function isLatestTimelineOptimisticGesture(
  updateElement: UpdateElement,
  gesture: TimelineOptimisticGesture,
  key: string,
): boolean {
  // The updater is shared across projects, and clip keys may be identical in
  // copied projects. A save completion can only touch the session that began it.
  return (
    gesture.sessionEpoch === usePlayerStore.getState().timelineSessionEpoch &&
    revisionsByUpdater.get(updateElement)?.get(key) === gesture.revisions.get(key)
  );
}

export function rollbackLatestTimelineOptimisticGesture(
  updateElement: UpdateElement,
  gesture: TimelineOptimisticGesture,
  rollbacks: ReadonlyArray<{ key: string; updates: Partial<TimelineElement> }>,
): void {
  for (const rollback of rollbacks) {
    if (isLatestTimelineOptimisticGesture(updateElement, gesture, rollback.key)) {
      updateElement(rollback.key, rollback.updates);
    }
  }
}
