import { describe, it, expect } from "vitest";
import { valueReadout } from "./trackHeaderLaneValues";
import { getTimelineClipRect } from "./timelineMarquee";
import { createTimelineRowGeometry } from "./timelineLayout";
import { trackHeights, getTimelineLaneTop } from "./timelineLayout";
describe("compact timeline controls", () => {
  it("rounds position readouts without modifying authored values", () => {
    const values = { x: -189.28, y: 301.56 };
    expect(valueReadout("position", values)).toBe("-189, 302");
    expect(values.y).toBe(301.56);
  });
  it("hit-tests compact and enlarged media bars at their rendered height", () => {
    const geometry = createTimelineRowGeometry([0], [172]);
    const picture = getTimelineClipRect({ start: 0, duration: 1, track: 0 }, geometry, 100, 0, 72)!;
    const audio = getTimelineClipRect({ start: 0, duration: 1, track: 0, mediaRow: 1 }, geometry, 100, 0, 72)!;
    expect(picture.height).toBe(66);
    expect(audio.top - picture.top).toBe(72);
  });
  it("sizes media rows independently of keyframe lanes", () => {
    expect(trackHeights([[{clipId: "a", laneCount: 1, mediaRowCount: 2}]], new Set(["a"]), 72)).toEqual([172]);
    expect(getTimelineLaneTop(1, 0, 2, 72)).toBe(172);
  });
});
