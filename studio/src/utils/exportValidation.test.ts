import { describe, expect, it } from "vitest";
import { validateExportSettings } from "./exportPolicy";

describe("standalone export settings validation", () => {
  it("accepts every canonical standalone format", () => {
    for (const format of ["mp4", "webm", "mov"] as const) {
      expect(
        validateExportSettings({
          format,
          quality: "standard",
          fps: 30,
          scale: "auto",
          dimensions: { width: 1920, height: 1080 },
        }),
      ).toEqual({ ok: true, issues: [] });
    }
  });

  it.each([
    ["format", { format: "gif" }],
    ["quality", { quality: "lossless" }],
    ["frame rate", { fps: 25 }],
    ["resolution", { scale: "8k" }],
  ] as const)("rejects unsupported %s", (_label, override) => {
    const result = validateExportSettings({
      format: "mp4",
      quality: "standard",
      fps: 30,
      scale: "auto",
      dimensions: { width: 1920, height: 1080 },
      ...override,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("rejects alpha output with a supersampled resolution", () => {
    expect(
      validateExportSettings({
        format: "webm",
        quality: "standard",
        fps: 30,
        scale: "4k",
        dimensions: { width: 1920, height: 1080 },
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects a preset that is not an integer upscale of the composition", () => {
    expect(
      validateExportSettings({
        format: "mp4",
        quality: "standard",
        fps: 30,
        scale: "1080p",
        dimensions: { width: 1280, height: 720 },
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects odd WebM dimensions before VP9 reaches FFmpeg", () => {
    expect(
      validateExportSettings({
        format: "webm",
        quality: "standard",
        fps: 30,
        scale: "auto",
        dimensions: { width: 1919, height: 1079 },
      }),
    ).toMatchObject({ ok: false });
  });
});
