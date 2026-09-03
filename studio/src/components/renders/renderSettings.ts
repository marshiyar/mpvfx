import {
  isExportFormat,
  isExportFrameRate,
  isExportQuality,
  isExportResolutionChoice,
  isValidExportOutputDimensions,
  isValidExportDimensions,
  compositionAspect,
  resolveExportTargetDimensions,
  type ExportDimensions,
  type ExportFormat,
  type ExportFrameRate,
  type ExportQuality,
  type ExportResolutionChoice,
} from "../../utils/exportPolicy";

const RENDER_SETTINGS_KEY = "hf-studio-render-settings";

export interface PersistedRenderSettings {
  format: ExportFormat;
  quality: ExportQuality;
  fps: ExportFrameRate;
  resolution: ExportResolutionChoice;
  customDimensions?: ExportDimensions;
}

export function resolvePersistedRenderResolution(
  resolution: ExportResolutionChoice,
  authoredDimensions: ExportDimensions | null | undefined,
): ExportResolutionChoice {
  if (resolution !== "1080p" && resolution !== "4k") return resolution;
  if (!isValidExportDimensions(authoredDimensions)) return resolution;
  const aspect = compositionAspect(authoredDimensions);
  if (resolution === "1080p") {
    return aspect === "portrait"
      ? "vertical-full-hd"
      : aspect === "square"
        ? "square-full-hd"
        : "full-hd";
  }
  return aspect === "portrait"
    ? "vertical-4k"
    : aspect === "square"
      ? "square-4k"
      : "uhd-4k";
}

/** Exact target that can be forwarded even when a scene card is not open. */
export function persistedRenderDimensions(
  settings: PersistedRenderSettings,
  authoredDimensions?: ExportDimensions | null,
): ExportDimensions | undefined {
  const resolution = resolvePersistedRenderResolution(
    settings.resolution,
    authoredDimensions,
  );
  if (resolution === "1080p" || resolution === "4k") return undefined;
  const dimensions = resolveExportTargetDimensions(
    resolution,
    authoredDimensions,
    settings.customDimensions,
  );
  return dimensions ?? undefined;
}

export function getPersistedRenderSettings(): PersistedRenderSettings {
  try {
    const raw = localStorage.getItem(RENDER_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Legacy 1080p/4K values described a scale, not a landscape size. Keep
      // them until the canvas aspect is available in the panel; migrating here
      // would silently turn portrait and square projects into padded landscape.
      const migratedResolution = parsed.resolution;
      return {
        format: isExportFormat(parsed.format) ? parsed.format : "mp4",
        quality: isExportQuality(parsed.quality) ? parsed.quality : "standard",
        fps: isExportFrameRate(parsed.fps) ? parsed.fps : 30,
        resolution: isExportResolutionChoice(migratedResolution) ? migratedResolution : "auto",
        ...(migratedResolution === "custom" && isValidExportOutputDimensions(parsed.customDimensions)
          ? { customDimensions: parsed.customDimensions }
          : {}),
      };
    }
  } catch {
    /* ignore */
  }
  return { format: "mp4", quality: "standard", fps: 30, resolution: "auto" };
}

export function persistRenderSettings(
  format: PersistedRenderSettings["format"],
  quality: PersistedRenderSettings["quality"],
  fps: PersistedRenderSettings["fps"],
  resolution: PersistedRenderSettings["resolution"],
  customDimensions?: ExportDimensions,
): void {
  try {
    localStorage.setItem(
      RENDER_SETTINGS_KEY,
      JSON.stringify({
        format,
        quality,
        fps,
        resolution,
        ...(resolution === "custom" && isValidExportOutputDimensions(customDimensions)
          ? { customDimensions }
          : {}),
      }),
    );
  } catch {
    /* ignore */
  }
}
