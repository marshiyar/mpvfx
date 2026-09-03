import { describe, expect, it } from "vitest";
import {
  compositionAspect,
  isValidExportDimensions,
  resolveEncodedDimensions,
  resolveExportDimensions,
} from "./exportPolicy";

describe("standalone export dimensions", () => {
  it.each([
    [{ width: 1920, height: 1080 }, "landscape"],
    [{ width: 1080, height: 1920 }, "portrait"],
    [{ width: 1080, height: 1080 }, "square"],
  ] as const)("classifies %o as %s", (dimensions, aspect) => {
    expect(compositionAspect(dimensions)).toBe(aspect);
  });

  it.each([
    { width: 0, height: 1080 },
    { width: -1, height: 1080 },
    { width: 1920.5, height: 1080 },
    { width: Number.NaN, height: 1080 },
    { width: 1920, height: Number.POSITIVE_INFINITY },
  ])("rejects invalid dimensions %o", (dimensions) => {
    expect(isValidExportDimensions(dimensions)).toBe(false);
  });

  it("resolves preset and native output dimensions", () => {
    expect(resolveExportDimensions("mp4", "4k", { width: 1920, height: 1080 })).toEqual({
      width: 3840,
      height: 2160,
    });
    expect(resolveExportDimensions("webm", "4k", { width: 1919, height: 1079 })).toEqual({
      width: 1919,
      height: 1079,
    });
  });

  it("pads H.264 output, rejects odd VP9 dimensions, and leaves ProRes 4:4:4 unchanged", () => {
    expect(resolveEncodedDimensions("mp4", { width: 1919, height: 1079 })).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(resolveEncodedDimensions("webm", { width: 1919, height: 1079 })).toBeNull();
    expect(resolveEncodedDimensions("mov", { width: 1919, height: 1079 })).toEqual({
      width: 1919,
      height: 1079,
    });
  });
});
