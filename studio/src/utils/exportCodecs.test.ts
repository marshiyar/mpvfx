import { describe, expect, it } from "vitest";
import { getEncoderPreset } from "@hyperframes/engine";
import { EXPORT_FORMAT_CAPABILITIES, SUPPORTED_EXPORT_QUALITIES } from "./exportPolicy";

describe("standalone export video codecs", () => {
  it("uses H.264 for SDR MP4 and H.265 for HDR MP4", () => {
    expect(EXPORT_FORMAT_CAPABILITIES.mp4.video).toMatchObject({
      codec: "h264",
      hdrCodec: "h265",
      encoder: "libx264",
      hdrEncoder: "libx265",
    });
  });

  it("uses VP9 for WebM and ProRes 4444 for MOV", () => {
    expect(EXPORT_FORMAT_CAPABILITIES.webm.video).toMatchObject({
      codec: "vp9",
      encoder: "libvpx-vp9",
    });
    expect(EXPORT_FORMAT_CAPABILITIES.mov.video).toMatchObject({
      codec: "prores",
      encoder: "prores_ks",
      profile: "4444",
    });
  });

  it.each(SUPPORTED_EXPORT_QUALITIES)(
    "stays in parity with the installed encoder presets at %s quality",
    (quality) => {
      for (const format of ["mp4", "webm", "mov"] as const) {
        const actual = getEncoderPreset(quality, format);
        expect(actual.codec).toBe(EXPORT_FORMAT_CAPABILITIES[format].video.codec);
        expect(actual.pixelFormat).toBe(
          EXPORT_FORMAT_CAPABILITIES[format].video.pixelFormat,
        );
      }
    },
  );
});
