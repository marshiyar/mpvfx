import { describe, expect, it } from "vitest";
import { getEncoderPreset } from "@hyperframes/engine";
import { EXPORT_FORMAT_CAPABILITIES } from "./exportPolicy";

describe("standalone export alpha channels", () => {
  it("is intentionally opaque for MP4", () => {
    expect(EXPORT_FORMAT_CAPABILITIES.mp4.alpha).toEqual({
      supported: false,
      bitDepth: 0,
    });
  });

  it.each([
    ["webm", "yuva420p", 8],
    ["mov", "yuva444p10le", 10],
  ] as const)("preserves %s alpha through %s", (format, pixelFormat, bitDepth) => {
    const capability = EXPORT_FORMAT_CAPABILITIES[format];
    expect(capability.alpha).toEqual({ supported: true, bitDepth });
    expect(capability.video.pixelFormat).toBe(pixelFormat);
    expect(getEncoderPreset("standard", format).pixelFormat).toBe(pixelFormat);
  });
});
