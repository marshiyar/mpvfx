import { describe, expect, it } from "vitest";
import type { TimelineElement } from "../../../player/index";
import { sameSilenceSegment } from "../useRemoveSilence";

describe("silence removal clip identity", () => {
  it("does not mistake an overlapping instance of the same media for a split piece", () => {
    const original = { tag: "video", start: 10, duration: 4, track: 1, sourceFile: "index.html", src: "clip.mp4", playbackStart: 5, playbackRate: 2 } as TimelineElement;
    const segment = { start: 11, end: 12, remove: true };
    const piece = { ...original, start: 11, duration: 1, playbackStart: 7 };
    expect(sameSilenceSegment(piece, segment, original)).toBe(true);
    expect(sameSilenceSegment({ ...piece, playbackStart: 0 }, segment, original)).toBe(false);
    expect(sameSilenceSegment({ ...piece, playbackRate: 1 }, segment, original)).toBe(false);
  });
});
