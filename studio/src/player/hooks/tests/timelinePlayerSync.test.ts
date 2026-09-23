import { describe, expect, it } from "vitest";
import { timelineElementsChanged } from "../timelinePlayerSync";
import type { TimelineElement } from "../../store/playerStore";

describe("timeline source synchronization", () => {
  const clip: TimelineElement = {
    id: "clip",
    key: "index.html::clip",
    tag: "video",
    src: "assets/a.mp4",
    start: 0,
    duration: 4,
    track: 0,
  };
  it.each([
    { src: "assets/b.mp4" },
    { key: "other.html::clip" },
    { sourceFile: "other.html" },
    { tag: "audio" },
  ])("detects source ownership changes with unchanged timing: %j", (change) => {
    expect(timelineElementsChanged([clip], [{ ...clip, ...change }])).toBe(true);
  });
  it("does not publish a duplicate timeline snapshot", () => {
    expect(timelineElementsChanged([clip], [{ ...clip }])).toBe(false);
  });
});
