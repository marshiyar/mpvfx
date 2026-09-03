import { afterEach, describe, expect, it, vi } from "vitest";
import { validateEngineConfigSnapshot } from "@hyperframes/engine";
import {
  STUDIO_EXTRACT_CACHE_MAX_BYTES,
  STUDIO_STREAMING_ENCODE_MAX_DURATION_SECONDS,
  buildStudioExportPerformanceProfile,
} from "./vite.export-performance-profile";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Studio export performance profile", () => {
  it("returns a complete producer config with automatic GPU and worker sizing", () => {
    const profile = buildStudioExportPerformanceProfile({
      extractCacheDir: "/generated/project-cache/export-frames",
    });

    expect(profile).toMatchObject({
      browserGpuMode: "auto",
      concurrency: "auto",
      enableStreamingEncode: true,
      streamingEncodeMaxDurationSeconds:
        STUDIO_STREAMING_ENCODE_MAX_DURATION_SECONDS,
      extractCacheDir: "/generated/project-cache/export-frames",
      extractCacheMaxBytes: STUDIO_EXTRACT_CACHE_MAX_BYTES,
    });
    expect(STUDIO_STREAMING_ENCODE_MAX_DURATION_SECONDS).toBeGreaterThan(324.4);
    expect(STUDIO_STREAMING_ENCODE_MAX_DURATION_SECONDS).toBeLessThanOrEqual(600);

    // A resolved producerConfig must be a full EngineConfig snapshot rather
    // than a partial collection of performance overrides.
    expect(profile).toEqual(
      expect.objectContaining({
        fps: expect.any(Number),
        quality: expect.any(String),
        format: expect.any(String),
        browserTimeout: expect.any(Number),
        protocolTimeout: expect.any(Number),
        ffmpegStreamingTimeout: expect.any(Number),
      }),
    );
    expect(() => validateEngineConfigSnapshot(profile)).not.toThrow();
  });

  it("does not let legacy environment settings force Studio back to slow capture", () => {
    vi.stubEnv("PRODUCER_BROWSER_GPU_MODE", "software");
    vi.stubEnv("PRODUCER_MAX_WORKERS", "1");
    vi.stubEnv("PRODUCER_ENABLE_STREAMING_ENCODE", "false");
    vi.stubEnv("PRODUCER_STREAMING_ENCODE_MAX_DURATION_SECONDS", "120");

    const profile = buildStudioExportPerformanceProfile({
      extractCacheDir: "/generated/export-cache",
    });

    expect(profile).toMatchObject({
      browserGpuMode: "auto",
      concurrency: "auto",
      enableStreamingEncode: true,
      forceScreenshot: false,
      streamingEncodeMaxDurationSeconds:
        STUDIO_STREAMING_ENCODE_MAX_DURATION_SECONDS,
    });
  });

  it("preserves safe operator limits and caps the extraction cache", () => {
    vi.stubEnv("FFMPEG_STREAMING_TIMEOUT_MS", "123456");
    vi.stubEnv("HYPERFRAMES_EXTRACT_CACHE_MAX_MB", "256");

    const profile = buildStudioExportPerformanceProfile({
      extractCacheDir: "/generated/export-cache",
    });

    expect(profile.ffmpegStreamingTimeout).toBe(123456);
    expect(profile.extractCacheMaxBytes).toBe(256 * 1024 ** 2);
    expect(profile.extractCacheMaxBytes).toBeLessThanOrEqual(
      STUDIO_EXTRACT_CACHE_MAX_BYTES,
    );
  });

  it("caps an oversized operator cache budget", () => {
    vi.stubEnv("HYPERFRAMES_EXTRACT_CACHE_MAX_MB", "8192");

    const profile = buildStudioExportPerformanceProfile({
      extractCacheDir: "/generated/export-cache",
    });

    expect(profile.extractCacheMaxBytes).toBe(STUDIO_EXTRACT_CACHE_MAX_BYTES);
  });

  it("rejects an empty cache directory instead of silently using an unbounded location", () => {
    expect(() =>
      buildStudioExportPerformanceProfile({ extractCacheDir: "" }),
    ).toThrow(/cache directory/i);
  });
});
