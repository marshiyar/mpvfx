import { describe, expect, it } from "vitest";
import { SUPPORTED_EXPORT_FRAME_RATES, exportFrameCount } from "./exportPolicy";

describe("standalone export frame rate and duration", () => {
  it("supports the frame rates exposed by the editor", () => {
    expect(SUPPORTED_EXPORT_FRAME_RATES).toEqual([24, 30, 60]);
  });

  it.each([
    [1, 24, 24],
    [1, 30, 30],
    [1, 60, 60],
    [1.001, 30, 31],
    [1.00001, 30, 30],
  ] as const)("turns %ss at %s fps into %s frames", (duration, fps, frames) => {
    expect(exportFrameCount(duration, fps)).toBe(frames);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns zero frames for invalid duration %s",
    (duration) => expect(exportFrameCount(duration, 30)).toBe(0),
  );
});
