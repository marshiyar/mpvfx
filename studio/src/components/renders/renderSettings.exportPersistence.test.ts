// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { getPersistedRenderSettings, persistRenderSettings } from "./renderSettings";
import { resolvePersistedRenderResolution } from "./renderSettings";

describe("export settings persistence", () => {
  beforeEach(() => localStorage.clear());

  it("defaults every export setting", () => {
    expect(getPersistedRenderSettings()).toEqual({
      format: "mp4",
      quality: "standard",
      fps: 30,
      resolution: "auto",
    });
  });

  it("round-trips format, quality, frame rate, and resolution", () => {
    persistRenderSettings("webm", "high", 60, "auto");
    expect(getPersistedRenderSettings()).toEqual({
      format: "webm",
      quality: "high",
      fps: 60,
      resolution: "auto",
    });

    persistRenderSettings("mp4", "draft", 24, "uhd-4k");
    expect(getPersistedRenderSettings()).toEqual({
      format: "mp4",
      quality: "draft",
      fps: 24,
      resolution: "uhd-4k",
    });
  });

  it.each(["1080p", "4k"])("preserves the legacy %s scale until the canvas aspect is known", (legacy) => {
    localStorage.setItem(
      "hf-studio-render-settings",
      JSON.stringify({ format: "mp4", quality: "standard", fps: 30, resolution: legacy }),
    );
    expect(getPersistedRenderSettings().resolution).toBe(legacy);
  });

  it("does not guess a legacy aspect before authored dimensions are available", () => {
    expect(resolvePersistedRenderResolution("4k", null)).toBe("4k");
    expect(resolvePersistedRenderResolution("4k", { width: 1080, height: 1920 })).toBe(
      "vertical-4k",
    );
  });

  it("round-trips a custom output target at the 8K boundary", () => {
    persistRenderSettings("mp4", "high", 60, "custom" as never, {
      width: 4320,
      height: 7680,
    });
    expect(getPersistedRenderSettings()).toMatchObject({
      resolution: "custom",
      customDimensions: { width: 4320, height: 7680 },
    });
  });

  it("falls back field-by-field for corrupt or unsupported values", () => {
    localStorage.setItem(
      "hf-studio-render-settings",
      JSON.stringify({ format: "gif", quality: "lossless", fps: 25, resolution: "8k" }),
    );
    expect(getPersistedRenderSettings()).toEqual({
      format: "mp4",
      quality: "standard",
      fps: 30,
      resolution: "auto",
    });
  });
});
