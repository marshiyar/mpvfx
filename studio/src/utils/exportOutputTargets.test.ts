import { describe, expect, it } from "vitest";
import {
  EXPORT_RESOLUTION_PRESETS,
  exportAspectRatioLabel,
  isValidExportOutputDimensions,
  resolveExportTargetDimensions,
} from "./exportPolicy";

describe("export output targets", () => {
  it("offers common landscape, portrait, square, social, classic, cinema, and 8K presets", () => {
    expect(EXPORT_RESOLUTION_PRESETS).toMatchObject({
      "hd-720": { width: 1280, height: 720, ratio: "16:9" },
      "full-hd": { width: 1920, height: 1080, ratio: "16:9" },
      qhd: { width: 2560, height: 1440, ratio: "16:9" },
      "uhd-4k": { width: 3840, height: 2160, ratio: "16:9" },
      "uhd-8k": { width: 7680, height: 4320, ratio: "16:9" },
      "vertical-full-hd": { width: 1080, height: 1920, ratio: "9:16" },
      "vertical-8k": { width: 4320, height: 7680, ratio: "9:16" },
      "square-full-hd": { width: 1080, height: 1080, ratio: "1:1" },
      "social-4-5": { width: 1080, height: 1350, ratio: "4:5" },
      "classic-4-3": { width: 2880, height: 2160, ratio: "4:3" },
      "cinema-21-9": { width: 5120, height: 2160, ratio: "64:27" },
    });
  });

  it("caps custom output at an 8K long edge and 4K short edge in either orientation", () => {
    expect(isValidExportOutputDimensions({ width: 7680, height: 4320 })).toBe(true);
    expect(isValidExportOutputDimensions({ width: 4320, height: 7680 })).toBe(true);
    expect(isValidExportOutputDimensions({ width: 4320, height: 4320 })).toBe(true);
    expect(isValidExportOutputDimensions({ width: 7682, height: 4320 })).toBe(false);
    expect(isValidExportOutputDimensions({ width: 4322, height: 4322 })).toBe(false);
  });

  it.each([
    { width: 0, height: 1080 },
    { width: 1920, height: -2 },
    { width: 1920.5, height: 1080 },
    { width: 1919, height: 1080 },
    { width: Number.NaN, height: 1080 },
  ])("rejects unusable custom dimensions %o", (dimensions) => {
    expect(isValidExportOutputDimensions(dimensions)).toBe(false);
  });

  it("labels exact and custom aspect ratios without reducing them to orientation", () => {
    expect(exportAspectRatioLabel({ width: 1920, height: 1080 })).toBe("16:9");
    expect(exportAspectRatioLabel({ width: 1080, height: 1350 })).toBe("4:5");
    expect(exportAspectRatioLabel({ width: 2048, height: 1080 })).toBe("256:135");
  });

  it("resolves Auto, fixed presets, and custom dimensions", () => {
    const authored = { width: 1920, height: 1080 };
    expect(resolveExportTargetDimensions("auto", authored)).toEqual(authored);
    expect(resolveExportTargetDimensions("uhd-8k", authored)).toEqual({
      width: 7680,
      height: 4320,
    });
    expect(resolveExportTargetDimensions("custom", authored, { width: 2048, height: 1080 })).toEqual({
      width: 2048,
      height: 1080,
    });
    expect(resolveExportTargetDimensions("custom", authored, { width: 7682, height: 4320 })).toBeNull();
  });
});
