import {
  resolveConfig,
  type EngineConfig,
} from "@hyperframes/engine";

/**
 * Keep the streaming pipe available for ordinary long-form edits while still
 * bounding it below durations where a disk-backed render is the safer route.
 */
export const STUDIO_STREAMING_ENCODE_MAX_DURATION_SECONDS = 10 * 60;

/**
 * Reused extracted frames are valuable, but the editor must not grow an
 * unbounded cache on a user's system drive.
 */
export const STUDIO_EXTRACT_CACHE_MAX_BYTES = 2 * 1024 ** 3;

export interface StudioExportPerformanceProfileInput {
  /** A generated, editor-owned cache directory for reusable extracted frames. */
  extractCacheDir: string;
}

/**
 * Build the complete EngineConfig snapshot consumed by producerConfig.
 *
 * resolveConfig retains safe operator settings such as timeouts, memory mode,
 * and an explicitly smaller cache budget. Studio owns the settings that avoid
 * its known slow export path: automatic browser GPU probing, automatic worker
 * sizing, and streaming encode for edits up to ten minutes.
 */
export function buildStudioExportPerformanceProfile({
  extractCacheDir,
}: StudioExportPerformanceProfileInput): EngineConfig {
  if (!extractCacheDir.trim()) {
    throw new Error("Studio export cache directory must not be empty");
  }

  const resolved = resolveConfig({
    browserGpuMode: "auto",
    concurrency: "auto",
    enableStreamingEncode: true,
    streamingEncodeMaxDurationSeconds:
      STUDIO_STREAMING_ENCODE_MAX_DURATION_SECONDS,
    extractCacheDir,
  });

  return {
    ...resolved,
    extractCacheDir,
    extractCacheMaxBytes: Math.min(
      resolved.extractCacheMaxBytes,
      STUDIO_EXTRACT_CACHE_MAX_BYTES,
    ),
  };
}
