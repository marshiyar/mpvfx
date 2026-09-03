import { describe, expect, it } from "vitest";
import { EXPORT_FORMAT_CAPABILITIES } from "./exportPolicy";

describe("standalone export audio", () => {
  it.each([
    ["mp4", "aac", 192],
    ["mov", "aac", 192],
    ["webm", "opus", 128],
  ] as const)("muxes %s audio as %s at %d kbps", (format, codec, bitrateKbps) => {
    expect(EXPORT_FORMAT_CAPABILITIES[format].audio).toEqual({
      codec,
      bitrateKbps,
      sampleRateHz: 48_000,
      channels: 2,
      optional: true,
    });
  });

  it("does not require an audio track to export video", () => {
    for (const capability of Object.values(EXPORT_FORMAT_CAPABILITIES)) {
      expect(capability.audio.optional).toBe(true);
    }
  });
});
