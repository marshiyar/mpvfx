import type { TimelineElement } from "../store/playerStore";
import { isAudioTimelineElement } from "../../features/timeline/timelineInspector";

/** Media classification for icons and audio controls, independent of row placement. */
export type TrackZone = "visual" | "audio";

export function classifyZone(el: TimelineElement): TrackZone {
  return isAudioTimelineElement(el) ? "audio" : "visual";
}

/** Track placement is authored state. Discovery never packs or sorts clips by
 * type, overlap, or canvas z-index: those edits cannot move other rows. */
export function normalizeToZones(elements: TimelineElement[]): TimelineElement[] {
  return elements;
}

export function normalizeDiscoveredTimelineElements(
  elements: TimelineElement[],
): TimelineElement[] {
  let projected = elements;
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]!;
    if (!Number.isFinite(element.authoredTrack) || element.authoredTrack === element.track) continue;
    if (projected === elements) projected = [...elements];
    projected[index] = { ...element, track: element.authoredTrack! };
  }
  return normalizeToZones(projected);
}
