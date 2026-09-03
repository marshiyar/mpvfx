import { describe, expect, it } from "vitest";
import { buildEncoderArgs, getEncoderPreset } from "@hyperframes/engine";
import { EXPORT_FORMAT_CAPABILITIES } from "./exportPolicy";

function argsFor(
  format: "mp4" | "webm" | "mov",
  hdr?: { transfer: "pq" | "hlg" },
): string[] {
  const preset = getEncoderPreset("standard", format, hdr);
  return buildEncoderArgs(
    { fps: { num: 30, den: 1 }, width: 1920, height: 1080, ...preset },
    ["-framerate", "30", "-i", "frame-%06d.png"],
    `out.${format}`,
  );
}

describe("standalone export color space and profiles", () => {
  it("tags SDR MP4 as limited-range BT.709", () => {
    const args = argsFor("mp4");
    expect(args).toEqual(
      expect.arrayContaining([
        "-colorspace:v",
        "bt709",
        "-color_primaries:v",
        "bt709",
        "-color_trc:v",
        "bt709",
        "-color_range",
        "tv",
      ]),
    );
    expect(EXPORT_FORMAT_CAPABILITIES.mp4.color.sdr).toEqual({
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      range: "limited",
    });
  });

  it.each([
    ["pq", "smpte2084"],
    ["hlg", "arib-std-b67"],
  ] as const)("tags %s HDR MP4 as BT.2020 with %s transfer", (transfer, tag) => {
    const args = argsFor("mp4", { transfer });
    expect(args).toEqual(
      expect.arrayContaining([
        "-colorspace:v",
        "bt2020nc",
        "-color_primaries:v",
        "bt2020",
        "-color_trc:v",
        tag,
        "-color_range",
        "tv",
      ]),
    );
  });

  it("does not advertise HDR for alpha output formats", () => {
    expect(EXPORT_FORMAT_CAPABILITIES.webm.color.hdr).toBeNull();
    expect(EXPORT_FORMAT_CAPABILITIES.mov.color.hdr).toBeNull();
  });
});
