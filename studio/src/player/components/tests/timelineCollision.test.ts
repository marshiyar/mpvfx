import { describe, expect, it } from "vitest";
import type { TimelineElement } from "../../store/playerStore";
import {
  isLaneFree,
  resolveCollisionFreeTrack,
  resolveInsertRow,
  resolvePlacement,
  resolveZoneDropPlacement,
  timeRangesOverlap,
} from "../timelineCollision";
import { INSERT_BOUNDARY_BAND } from "../timelineLayout";

function el(id: string, track: number, start: number, duration: number): TimelineElement {
  return { id, tag: "video", start, duration, track };
}

describe("timeRangesOverlap", () => {
  it("detects overlap and treats touching edges as free (half-open)", () => {
    expect(timeRangesOverlap(0, 2, 1, 3)).toBe(true);
    expect(timeRangesOverlap(0, 2, 2, 4)).toBe(false); // touching at 2
    expect(timeRangesOverlap(2, 4, 0, 2)).toBe(false);
  });
});

describe("isLaneFree", () => {
  const els = [el("a", 0, 0, 5), el("b", 1, 2, 3)];

  it("is free when nothing overlaps on the track", () => {
    expect(isLaneFree(els, 2, 0, 5, null)).toBe(true);
    expect(isLaneFree(els, 0, 6, 8, null)).toBe(true); // same track, no time overlap
  });

  it("is occupied when a clip overlaps on the same track", () => {
    expect(isLaneFree(els, 0, 1, 3, null)).toBe(false);
  });

  it("ignores the excluded (dragged) clip", () => {
    expect(isLaneFree(els, 0, 1, 3, "a")).toBe(true);
  });
});

describe("resolvePlacement", () => {
  const trackOrder = [0, 1, 2, 3];

  it("keeps the desired lane when it is free", () => {
    const els = [el("a", 2, 0, 4)];
    expect(
      resolvePlacement({
        elements: els,
        desiredTrack: 1,
        start: 0,
        duration: 4,
        trackOrder,
        excludeKey: null,
      }),
    ).toEqual({
      track: 1,
      needsInsert: false,
    });
  });

  it("pushes up to the nearest free lane above when the target is occupied", () => {
    // desired = 2 occupied; 1 free above → land on 1
    const els = [el("blocker", 2, 0, 4)];
    expect(
      resolvePlacement({
        elements: els,
        desiredTrack: 2,
        start: 1,
        duration: 2,
        trackOrder,
        excludeKey: null,
      }),
    ).toEqual({ track: 1, needsInsert: false });
  });

  it("prefers up even when a lane below is also free", () => {
    // desired 2 occupied; both 1 (up) and 3 (down) free → up wins
    const els = [el("blocker", 2, 0, 5)];
    expect(
      resolvePlacement({
        elements: els,
        desiredTrack: 2,
        start: 0,
        duration: 3,
        trackOrder,
        excludeKey: null,
      }),
    ).toEqual({ track: 1, needsInsert: false });
  });

  it("falls to a lane below when every lane above is occupied", () => {
    // desired 1 occupied; 0 occupied above; 2 free below → land on 2
    const els = [el("x", 0, 0, 5), el("y", 1, 0, 5)];
    expect(
      resolvePlacement({
        elements: els,
        desiredTrack: 1,
        start: 1,
        duration: 2,
        trackOrder,
        excludeKey: null,
      }),
    ).toEqual({ track: 2, needsInsert: false });
  });

  it("signals needsInsert when no lane is free", () => {
    const els = [el("a", 0, 0, 9), el("b", 1, 0, 9), el("c", 2, 0, 9), el("d", 3, 0, 9)];
    expect(
      resolvePlacement({
        elements: els,
        desiredTrack: 2,
        start: 1,
        duration: 2,
        trackOrder,
        excludeKey: null,
      }),
    ).toEqual({ track: 2, needsInsert: true });
  });

  it("signals needsInsert when the desired track is occupied but absent from the zone's lanes (#2195)", () => {
    // desiredTrack 5 is occupied yet not in trackOrder (its kind-zone has no lane
    // here). Landing on it would overlap, so the empty-zone branch must insert —
    // not silently land on the occupied track (the placement hole).
    const els = [el("blocker", 5, 0, 5)];
    expect(
      resolvePlacement({
        elements: els,
        desiredTrack: 5,
        start: 1,
        duration: 2,
        trackOrder: [],
        excludeKey: null,
      }),
    ).toEqual({ track: 5, needsInsert: true });
  });

  it("signals needsInsert when the desired track is FREE but absent from the zone's lanes (#2195 free-span hole)", () => {
    // desiredTrack 5 is FREE (no overlap) yet not in trackOrder — its kind-zone has
    // no lane here. The old code short-circuited on isLaneFree and landed on the
    // foreign-zone lane; the zone check must win and signal an insert.
    const els = [el("elsewhere", 9, 0, 5)];
    expect(
      resolvePlacement({
        elements: els,
        desiredTrack: 5,
        start: 1,
        duration: 2,
        trackOrder: [],
        excludeKey: null,
      }),
    ).toEqual({ track: 5, needsInsert: true });
  });

  it("placeholder-scenario excludes the dragged clip so it does not collide with itself", () => {
    const els = [el("self", 1, 0, 5)];
    expect(
      resolvePlacement({
        elements: els,
        desiredTrack: 1,
        start: 0,
        duration: 5,
        trackOrder,
        excludeKey: "self",
      }),
    ).toEqual({ track: 1, needsInsert: false });
  });
});

describe("resolveZoneDropPlacement", () => {
  it("moves an overlapping video to the nearest free track instead of stacking it", () => {
    const elements = [el("existing", 0, 0, 5), el("dragged", 1, 10, 2)];

    expect(
      resolveZoneDropPlacement({
        order: [0, 1, 2],
        audioTracks: new Set(),
        elements,
        desiredTrack: 0,
        deliberateInsertRow: null,
        start: 1,
        duration: 2,
        dragKey: "dragged",
        isAudio: false,
      }),
    ).toEqual({ track: 1, insertRow: null });
  });

  it("creates a track when every destination track has a same-zone overlap", () => {
    const elements = [el("a", 0, 0, 5), el("b", 1, 0, 5), el("dragged", 1, 10, 2)];

    expect(
      resolveZoneDropPlacement({
        order: [0, 1],
        audioTracks: new Set(),
        elements,
        desiredTrack: 1,
        deliberateInsertRow: null,
        start: 1,
        duration: 2,
        dragKey: "dragged",
        isAudio: false,
        preferInsertAbove: true,
      }),
    ).toEqual({ track: 1, insertRow: 1 });
  });

  it("allows audio and visual clips to share a mixed track", () => {
    const elements = [el("picture", 0, 0, 5)];

    expect(
      resolveZoneDropPlacement({
        order: [0],
        audioTracks: new Set([0]),
        elements,
        desiredTrack: 0,
        deliberateInsertRow: null,
        start: 1,
        duration: 2,
        dragKey: "new-sound",
        isAudio: true,
      }),
    ).toEqual({ track: 0, insertRow: null });
  });

  it("honors an explicit boundary insertion even when the span overlaps", () => {
    const elements = [el("existing", 0, 0, 5)];

    expect(
      resolveZoneDropPlacement({
        order: [0],
        audioTracks: new Set(),
        elements,
        desiredTrack: 0,
        deliberateInsertRow: 0,
        start: 1,
        duration: 2,
        dragKey: "new-video",
        isAudio: false,
      }),
    ).toEqual({ track: 0, insertRow: 0 });
  });
});

describe("resolveCollisionFreeTrack", () => {
  it("gives a new visual asset a fresh track when all existing visual tracks overlap", () => {
    expect(
      resolveCollisionFreeTrack({
        elements: [el("existing-a", 0, 0, 5), el("existing-b", 1, 0, 5)],
        trackOrder: [0, 1],
        desiredTrack: 0,
        start: 1,
        duration: 2,
        isAudio: false,
      }),
    ).toBe(2);
  });

  it("keeps a new audio asset on a visual row when no audio clip collides", () => {
    expect(
      resolveCollisionFreeTrack({
        elements: [el("picture", 0, 0, 5)],
        trackOrder: [0],
        desiredTrack: 0,
        start: 1,
        duration: 2,
        isAudio: true,
      }),
    ).toBe(0);
  });
});

describe("resolveInsertRow", () => {
  const n = 3; // three lanes: rows 0,1,2

  it("targets the lane (null) when over its middle band", () => {
    expect(resolveInsertRow(1.5, n, 0.22)).toBe(null); // dead center of lane 1
  });

  it("inserts at the top boundary of a lane when near its top edge", () => {
    expect(resolveInsertRow(1.1, n, 0.22)).toBe(1); // just into lane 1 → boundary above it
  });

  it("inserts at the bottom boundary of a lane when near its bottom edge", () => {
    expect(resolveInsertRow(1.9, n, 0.22)).toBe(2); // near bottom of lane 1 → boundary below
  });

  it("inserts above the top lane when the pointer is above everything", () => {
    expect(resolveInsertRow(-0.5, n, 0.22)).toBe(0);
  });

  it("inserts below the bottom lane when the pointer is past the last lane", () => {
    expect(resolveInsertRow(3.4, n, 0.22)).toBe(3);
  });
});

describe("resolveInsertRow — production band only arms in the inter-clip gutter (UX rule 1)", () => {
  // The production band equals the clip inset (CLIP_Y / TRACK_H): a clip body fills
  // [band, 1 − band] of its row, so an insert must ONLY arm in the thin gutter that
  // straddles a boundary — never while the pointer is over a clip body. This is the
  // regression for the plain-horizontal-drag misfire (the old 0.32 band armed an
  // insert across ~64% of every row).
  const n = 3;
  const b = INSERT_BOUNDARY_BAND;

  it("the band is the clip inset (3/48), not the old feel-tuned 0.32", () => {
    expect(b).toBeCloseTo(3 / 48, 10);
    expect(b).toBeLessThan(0.1);
  });

  it("returns null across the WHOLE clip body of every lane (no insert = move-to-lane)", () => {
    // Sweep each lane's body [band+ε, 1−band−ε] in fine steps → always a move.
    for (let lane = 0; lane < n; lane++) {
      for (let frac = b + 0.01; frac <= 1 - b - 0.01 + 1e-9; frac += 0.02) {
        expect(resolveInsertRow(lane + frac, n, b)).toBeNull();
      }
    }
  });

  it("arms an insert in the gutter straddling every internal boundary (dead-zone-free)", () => {
    // Just under a boundary → insert BELOW the upper lane; just over → ABOVE the
    // lower lane. Both resolve to the same boundary row, so the gutter has no dead
    // spot that neither moves nor inserts.
    expect(resolveInsertRow(1 - b / 2, n, b)).toBe(1); // bottom gutter of lane 0
    expect(resolveInsertRow(1 + b / 2, n, b)).toBe(1); // top gutter of lane 1
    expect(resolveInsertRow(2 - b / 2, n, b)).toBe(2);
    expect(resolveInsertRow(2 + b / 2, n, b)).toBe(2);
  });

  it("still arms a top / bottom insert above the first / below the last lane", () => {
    expect(resolveInsertRow(b / 2, n, b)).toBe(0); // top gutter of lane 0 → insert above top
    expect(resolveInsertRow(-0.4, n, b)).toBe(0); // in the top breathing pad
    expect(resolveInsertRow(n - b / 2, n, b)).toBe(n); // bottom gutter of last lane
    expect(resolveInsertRow(n + 0.4, n, b)).toBe(n); // in the bottom breathing pad
  });
});
