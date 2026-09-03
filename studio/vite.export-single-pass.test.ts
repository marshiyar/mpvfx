import { describe, expect, it } from "vitest";
import { planSinglePassExportDimensions } from "./vite.export-single-pass";

describe("single-pass export dimension planning", () => {
  it("keeps an identical landscape target at the authored size", () => {
    expect(
      planSinglePassExportDimensions({
        authored: { width: 1920, height: 1080 },
        requested: { width: 1920, height: 1080 },
      }),
    ).toEqual({ resizeRequired: false });
  });

  it.each([
    [
      "landscape",
      { width: 1920, height: 1080 },
      { width: 3840, height: 2160 },
      "landscape-4k",
    ],
    [
      "portrait",
      { width: 1080, height: 1920 },
      { width: 2160, height: 3840 },
      "portrait-4k",
    ],
    [
      "square",
      { width: 1080, height: 1080 },
      { width: 2160, height: 2160 },
      "square-4k",
    ],
  ] as const)(
    "maps a supported %s upscale to a producer preset",
    (_name, authored, requested, outputResolution) => {
      expect(planSinglePassExportDimensions({ authored, requested })).toEqual({
        resizeRequired: false,
        outputResolution,
      });
    },
  );

  it.each([
    ["aspect mismatch", { width: 1920, height: 1080 }, { width: 1080, height: 1080 }],
    ["custom dimensions", { width: 1920, height: 1080 }, { width: 2560, height: 1440 }],
    ["unsupported integer scale", { width: 1920, height: 1080 }, { width: 5760, height: 3240 }],
    ["downsample", { width: 3840, height: 2160 }, { width: 1920, height: 1080 }],
  ] as const)("retains the resize pass for a %s", (_name, authored, requested) => {
    expect(planSinglePassExportDimensions({ authored, requested })).toEqual({
      resizeRequired: true,
    });
  });
});
