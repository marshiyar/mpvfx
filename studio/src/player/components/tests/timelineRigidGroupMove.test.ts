import { describe, expect, it } from "vitest";
import type { TimelineElement } from "../../store/playerStore";
import { resolveRigidGroupMove } from "../timelineRigidGroupMove";

const clip = (id: string, track: number, start = 0, tag = "video"): TimelineElement => ({
  id, key: id, domId: id, tag, track, start, duration: 2,
});

function resolve(
  elements: TimelineElement[],
  desiredTrack: number,
  deltaSeconds = 0,
  selectedKeys = new Set(["a", "b"]),
  trackOrder = [2, 5, 9],
) {
  return resolveRigidGroupMove({
    elements, desiredTrack, deltaSeconds, selectedKeys, trackOrder, dragged: elements[0]!,
  });
}

describe("rigid selected clip row move", () => {
  it("shifts sparse display rows by index while preserving relative spacing", () => {
    expect(resolve([clip("a", 2), clip("b", 5)], 5, 3)).toMatchObject({
      valid: true, rowDelta: 1,
    });
  });

  it("refuses the whole formation when one passenger has no destination row", () => {
    expect(resolve([clip("a", 2), clip("b", 9)], 5)).toMatchObject({
      valid: false, rowDelta: 0,
    });
  });

  it("refuses the whole formation for an unselected same-zone collision", () => {
    expect(resolve([clip("a", 2), clip("b", 5), clip("block", 9)], 5)).toMatchObject({
      valid: false, rowDelta: 0,
    });
    expect(resolve([clip("a", 2), clip("b", 5), clip("block", 9, 10)], 5)).toMatchObject({
      valid: true, rowDelta: 1,
    });
  });

  it("accepts audio beside video in an already mixed destination row", () => {
    const elements = [
      clip("a", 2, 0, "audio"), clip("b", 5, 0, "audio"),
      clip("v5", 5, 0, "video"), clip("v9", 9, 0, "video"),
    ];
    // Moving a removes audio from row 2 and adds it to row 5, changing that
    // row's media-bar geometry. The conservative projection refuses it.
    expect(resolve(elements, 5)).toMatchObject({ valid: false });
    expect(resolve(elements, 2, 1)).toMatchObject({ valid: true, rowDelta: 0 });
  });

  it("refuses locked members and fractional synthetic target rows", () => {
    expect(resolve([clip("a", 2), { ...clip("b", 5), timelineLocked: true }], 5))
      .toMatchObject({ valid: false });
    expect(resolve([clip("a", 2), clip("b", 5)], 2.5, 0, new Set(["a", "b"]), [2, 2.5, 5]))
      .toMatchObject({ valid: false });
  });

  it("refuses a sparse authored projection that would reverse source-file row order", () => {
    const a = { ...clip("a", 2), sourceFile: "scene.html", authoredTrack: 4 };
    const b = { ...clip("b", 5), sourceFile: "scene.html", authoredTrack: 7 };
    // Row 9 has no authored occupant; extrapolation remains ordered here.
    expect(resolve([a, b], 5)).toMatchObject({ valid: true });
    // But from adjacent display rows 0/1, the same authored gap 4/7 would
    // extrapolate the lower selected member's new row 2 to authored 6, below
    // its upper companion's authored 7.
    const adjacent = [{ ...a, track: 0 }, { ...b, track: 1 }];
    expect(resolve(adjacent, 1, 0, new Set(["a", "b"]), [0, 1, 2]))
      .toMatchObject({ valid: false });
  });
});
