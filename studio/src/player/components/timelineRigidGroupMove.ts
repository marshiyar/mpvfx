import type { TimelineElement } from "../store/playerStore";
import { isAudioTimelineElement } from "../../features/timeline/timelineInspector";
import { canMoveTimelineElement } from "./timelineAuthoredMoveTarget";
import { timeRangesOverlap } from "./timelineCollision";
import { authoredTrackForLane } from "./timelineAuthoredTrack";

const keyOf = (element: TimelineElement) => element.key ?? element.id;

export interface RigidGroupMove {
  keys: ReadonlySet<string>;
  rowDelta: number;
  valid: boolean;
}

/** Validate the whole formation against existing rows before preview or commit.
 * Selected clips are excluded from collision checks because they move together.
 * A locked, missing, or synthetic selected member blocks a group row change. */
export function resolveRigidGroupMove(input: {
  elements: readonly TimelineElement[];
  selectedKeys: ReadonlySet<string>;
  dragged: TimelineElement;
  desiredTrack: number;
  trackOrder: readonly number[];
  deltaSeconds: number;
}): RigidGroupMove | null {
  const { elements, selectedKeys, dragged, desiredTrack, trackOrder, deltaSeconds } = input;
  const draggedKey = keyOf(dragged);
  if (!selectedKeys.has(draggedKey) || selectedKeys.size < 2) return null;
  const members = elements.filter((element) => selectedKeys.has(keyOf(element)));
  if (members.length < 2 || members.length !== selectedKeys.size) {
    return { keys: selectedKeys, rowDelta: 0, valid: false };
  }
  const originIndex = trackOrder.indexOf(dragged.track);
  const desiredIndex = trackOrder.indexOf(desiredTrack);
  if (originIndex < 0 || desiredIndex < 0 || !Number.isFinite(deltaSeconds)) {
    return { keys: selectedKeys, rowDelta: 0, valid: false };
  }
  const rowDelta = desiredIndex - originIndex;
  if (members.some((member) => !canMoveTimelineElement(member) || member.expandedParentStart != null)) {
    return { keys: selectedKeys, rowDelta: 0, valid: false };
  }
  const occupiedByTrackZone = new Map<string, TimelineElement[]>();
  for (const element of elements) {
    if (selectedKeys.has(keyOf(element))) continue;
    const key = `${element.track}:${isAudioTimelineElement(element) ? "audio" : "visual"}`;
    const occupied = occupiedByTrackZone.get(key) ?? [];
    occupied.push(element);
    occupiedByTrackZone.set(key, occupied);
  }
  const valid = members.every((member) => {
    const memberIndex = trackOrder.indexOf(member.track);
    const targetTrack = trackOrder[memberIndex + rowDelta];
    const start = member.start + deltaSeconds;
    if (
      memberIndex < 0 || !Number.isInteger(member.track) ||
      !Number.isInteger(targetTrack) || start < -1e-6
    ) return false;
    const key = `${targetTrack}:${isAudioTimelineElement(member) ? "audio" : "visual"}`;
    return !(occupiedByTrackZone.get(key) ?? []).some((other) =>
      timeRangesOverlap(start, start + member.duration, other.start, other.start + other.duration),
    );
  });
  if (!valid) return { keys: selectedKeys, rowDelta: 0, valid: false };
  if (rowDelta === 0) return { keys: selectedKeys, rowDelta: 0, valid: true };
  // A mixed audio/visual row has two media bars and a different height. Until
  // the drag projection can recompute row geometry, keep those topology edits
  // on the single-clip path instead of displaying passengers in the wrong bar.
  const projected = elements.map((element) => {
    if (!selectedKeys.has(keyOf(element))) return element;
    const row = trackOrder.indexOf(element.track) + rowDelta;
    return { ...element, track: trackOrder[row]! };
  });
  const mixedTracks = (items: readonly TimelineElement[]): ReadonlySet<number> => {
    const zones = new Map<number, number>();
    for (const element of items) {
      zones.set(element.track, (zones.get(element.track) ?? 0) |
        (isAudioTimelineElement(element) ? 1 : 2));
    }
    return new Set([...zones].filter(([, zone]) => zone === 3).map(([track]) => track));
  };
  const originalMixed = mixedTracks(elements);
  const projectedMixed = mixedTracks(projected);
  const changedTracks = new Set(members.flatMap((member) => [
    member.track, trackOrder[trackOrder.indexOf(member.track) + rowDelta]!,
  ]));
  if ([...changedTracks].some((track) => originalMixed.has(track) !== projectedMixed.has(track))) {
    return { keys: selectedKeys, rowDelta: 0, valid: false };
  }
  // A sparse source file may not have an authored lane corresponding to an
  // empty display row. The ordinary single-clip resolver extrapolates from its
  // nearest peer; for a formation that can reverse authored order or put two
  // distinct visible rows on one authored lane. Refuse those projections.
  const affectedSources = new Set(members.map((member) => member.sourceFile ?? null));
  const authoredLookupElements = [...elements];
  for (const source of affectedSources) {
    const authoredRows = elements
      .filter((element) => (element.sourceFile ?? null) === source)
      .map((element) => {
        const targetTrack = selectedKeys.has(keyOf(element))
          ? trackOrder[trackOrder.indexOf(element.track) + rowDelta]!
          : element.track;
        const authored = selectedKeys.has(keyOf(element)) && rowDelta !== 0
          ? authoredTrackForLane(targetTrack, authoredLookupElements, element)
          : (element.authoredTrack ?? element.track);
        return { targetTrack, authored };
      })
      .sort((left, right) => left.targetTrack - right.targetTrack || left.authored - right.authored);
    for (let index = 1; index < authoredRows.length; index += 1) {
      const previous = authoredRows[index - 1]!;
      const current = authoredRows[index]!;
      if (
        (current.targetTrack === previous.targetTrack && current.authored !== previous.authored) ||
        (current.targetTrack !== previous.targetTrack && current.authored <= previous.authored)
      ) return { keys: selectedKeys, rowDelta: 0, valid: false };
    }
  }
  return { keys: selectedKeys, rowDelta, valid: true };
}
