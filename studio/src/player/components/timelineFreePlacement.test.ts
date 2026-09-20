import { describe, it, expect } from "vitest";
import { normalizeDiscoveredTimelineElements } from "./timelineZones";
import { resolveZoneDropPlacement } from "./timelineCollision";
import type { TimelineElement } from "../store/playerStore";
const clip = (id: string, tag: string, track: number, start = 0): TimelineElement => ({ id, tag, track, start, duration: 4 });
describe("authored tracks stay where the user put them", () => {
  it("keeps mixed, overlapping clips and empty row gaps through rediscovery", () => {
    const clips = [clip("audio", "audio", 3), clip("image", "img", 3), clip("video", "video", 7)];
    expect(normalizeDiscoveredTimelineElements(clips).map(c => [c.id, c.track])).toEqual(clips.map(c => [c.id, c.track]));
    expect(normalizeDiscoveredTimelineElements(clips.map(c => ({ ...c, start: 2, zIndex: 20 })) ).map(c => c.track)).toEqual([3, 3, 7]);
  });
  it("lands on the requested occupied mixed track without moving another row", () => {
    expect(resolveZoneDropPlacement({ order: [0, 1, 2], audioTracks: new Set([2]), elements: [clip("video", "video", 0)], desiredTrack: 0,
      deliberateInsertRow: null, start: 0, duration: 4, dragKey: "audio", isAudio: true,
    })).toEqual({ track: 0, insertRow: null });
  });
});
