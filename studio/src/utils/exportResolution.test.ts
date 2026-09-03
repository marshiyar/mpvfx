import { describe, expect, it } from "vitest";
import {
  exportScaleApplies,
  normalizeExportScaleForFormat,
  resolveExportResolution,
} from "./exportPolicy";

describe("standalone export resolution", () => {
  it.each([
    ["1080p", { width: 1920, height: 1080 }, "landscape"],
    ["4k", { width: 1920, height: 1080 }, "landscape-4k"],
    ["1080p", { width: 1080, height: 1920 }, "portrait"],
    ["4k", { width: 1080, height: 1920 }, "portrait-4k"],
    ["1080p", { width: 1080, height: 1080 }, "square"],
    ["4k", { width: 1080, height: 1080 }, "square-4k"],
  ] as const)("resolves MP4 %s from %o to %s", (scale, dimensions, expected) => {
    expect(resolveExportResolution("mp4", scale, dimensions)).toBe(expected);
  });

  it("keeps Auto at authored dimensions by omitting an output preset", () => {
    expect(resolveExportResolution("mp4", "auto", { width: 1440, height: 1080 })).toBe("auto");
  });

  it.each(["webm", "mov"] as const)(
    "forces %s to native resolution because alpha supersampling is unsupported",
    (format) => {
      expect(normalizeExportScaleForFormat(format, "4k")).toBe("auto");
      expect(resolveExportResolution(format, "4k", { width: 1920, height: 1080 })).toBe(
        "auto",
      );
      expect(exportScaleApplies(format, "4k", { width: 1920, height: 1080 })).toBe(false);
    },
  );

  it.each([
    [{ width: 1280, height: 720 }, "1080p"],
    [{ width: 3840, height: 2160 }, "1080p"],
    [{ width: 1000, height: 1000 }, "4k"],
  ] as const)("rejects non-integer or downsample scale for %o", (dimensions, scale) => {
    expect(exportScaleApplies("mp4", scale, dimensions)).toBe(false);
  });
});
