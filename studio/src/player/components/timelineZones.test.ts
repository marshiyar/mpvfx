import { describe, expect, it } from "vitest";
import type { TimelineElement } from "../store/playerStore";
import { mergeTimelineElementsPreservingDowngrades } from "../lib/timelineDOM";
import {
  classifyZone,
  normalizeDiscoveredTimelineElements,
  normalizeToZones,
} from "./timelineZones";

function el(id: string, tag: string, track: number, duration = 2): TimelineElement {
  return { id, tag, start: 0, duration, track };
}

function zClip(
  id: string,
  start: number,
  duration: number,
  track: number,
  zIndex: number,
  tag = "video",
): TimelineElement {
  return { id, tag, start, duration, track, zIndex };
}

function trackOf(els: TimelineElement[], id: string): number {
  return els.find((e) => e.id === id)!.track;
}

/** Assert normalizeToZones is idempotent: re-zoning keeps every clip's lane. */
function expectZoningIdempotent(input: TimelineElement[]): void {
  const once = normalizeToZones(input);
  const twice = normalizeToZones(once);
  for (const e of once) expect(trackOf(twice, e.id)).toBe(e.track);
}

describe("classifyZone", () => {
  it("audio → audio; video / image / everything else → visual", () => {
    expect(classifyZone(el("m", "audio", 3))).toBe("audio");
    expect(classifyZone(el("v", "video", 1))).toBe("visual");
    expect(classifyZone(el("i", "img", 0))).toBe("visual");
  });

  it("zone identity invariant: normalizeToZones preserves each clip's zone (mixed input)", () => {
    // normalizeToZones only remaps lanes — it must never reclassify a clip's zone.
    const input = [
      el("v", "video", 0),
      el("a1", "audio", 1),
      el("i", "img", 2),
      el("a2", "audio", 3),
    ];
    const out = normalizeToZones(input);
    for (const e of input) {
      expect(classifyZone(out.find((o) => o.id === e.id)!)).toBe(classifyZone(e));
    }
  });
});

describe("stable authored rows", () => {
  it("restores authored lanes during a partial discovery without repacking", () => {
    const rawA = { ...el("a", "video", 7), key: "index.html#a" };
    const rawB = { ...el("b", "audio", 12), key: "index.html#b", compositionSrc: "b.html" };
    const current = normalizeDiscoveredTimelineElements([rawA, rawB]);
    const partial = mergeTimelineElementsPreservingDowngrades(current, [rawA], 10, 10);
    expect(normalizeDiscoveredTimelineElements(partial).map(({ id, track }) => ({ id, track })))
      .toEqual([{ id: "a", track: 7 }, { id: "b", track: 12 }]);
    expect(normalizeDiscoveredTimelineElements([{ ...rawB, track: 1, authoredTrack: 12 }])[0]!.track).toBe(12);
  });

  it("retains row gaps, mixed media and overlapping clips through style and timing changes", () => {
    const clips = [zClip("audio", 0, 10, 0, 0, "audio"), zClip("image", 0, 10, 0, 9, "img"), zClip("video", 2, 7, 5, 1)];
    expect(normalizeToZones(clips)).toBe(clips);
    const changed = clips.map(clip => ({ ...clip, zIndex: 100, start: 3 }));
    expect(normalizeToZones(changed).map(clip => clip.track)).toEqual([0, 0, 5]);
    expectZoningIdempotent(changed);
  });
});
