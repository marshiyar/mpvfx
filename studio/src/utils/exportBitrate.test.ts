import { describe, expect, it } from "vitest";
import { ENCODER_PRESETS } from "@hyperframes/engine";
import {
  EXPORT_FORMAT_CAPABILITIES,
  estimateExportAudioSizeBytes,
  exportQualityCrf,
} from "./exportPolicy";

describe("standalone export bitrate and rate control", () => {
  it.each([
    ["draft", 28],
    ["standard", 18],
    ["high", 15],
  ] as const)("maps %s quality to CRF %d", (quality, crf) => {
    expect(exportQualityCrf(quality)).toBe(crf);
    expect(ENCODER_PRESETS[quality].quality).toBe(crf);
  });

  it("uses CRF for MP4/WebM without claiming a fixed video bitrate", () => {
    for (const format of ["mp4", "webm"] as const) {
      expect(EXPORT_FORMAT_CAPABILITIES[format].video.rateControl).toBe("crf");
      expect(EXPORT_FORMAT_CAPABILITIES[format].video.bitrateKbps).toBeNull();
    }
  });

  it("treats ProRes 4444 as a fixed profile where the quality selector does not apply", () => {
    expect(EXPORT_FORMAT_CAPABILITIES.mov.video).toMatchObject({
      rateControl: "fixed-profile",
      bitrateKbps: null,
      qualityApplies: false,
    });
  });

  it("estimates only the fixed audio contribution to file size", () => {
    expect(estimateExportAudioSizeBytes(10, "mp4", true)).toBe(240_000);
    expect(estimateExportAudioSizeBytes(10, "webm", true)).toBe(160_000);
    expect(estimateExportAudioSizeBytes(10, "mov", false)).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0])(
    "returns zero for invalid duration %s",
    (duration) => expect(estimateExportAudioSizeBytes(duration, "mp4", true)).toBe(0),
  );
});
