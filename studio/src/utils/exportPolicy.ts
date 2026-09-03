import { CANVAS_DIMENSIONS, type CanvasResolution } from "@hyperframes/parsers";

export const SUPPORTED_EXPORT_FORMATS = ["mp4", "webm", "mov"] as const;
export const SUPPORTED_EXPORT_QUALITIES = ["draft", "standard", "high"] as const;
export const SUPPORTED_EXPORT_FRAME_RATES = [24, 30, 60] as const;
export const SUPPORTED_EXPORT_SCALES = ["auto", "1080p", "4k"] as const;

export const MAX_EXPORT_LONG_EDGE = 7680;
export const MAX_EXPORT_SHORT_EDGE = 4320;

export const EXPORT_RESOLUTION_PRESETS = {
  "hd-720": { label: "HD", width: 1280, height: 720, ratio: "16:9", group: "Landscape" },
  "full-hd": { label: "Full HD", width: 1920, height: 1080, ratio: "16:9", group: "Landscape" },
  qhd: { label: "QHD", width: 2560, height: 1440, ratio: "16:9", group: "Landscape" },
  "uhd-4k": { label: "4K UHD", width: 3840, height: 2160, ratio: "16:9", group: "Landscape" },
  "uhd-8k": { label: "8K UHD", width: 7680, height: 4320, ratio: "16:9", group: "Landscape" },
  "vertical-hd": { label: "Vertical HD", width: 720, height: 1280, ratio: "9:16", group: "Portrait" },
  "vertical-full-hd": { label: "Vertical Full HD", width: 1080, height: 1920, ratio: "9:16", group: "Portrait" },
  "vertical-qhd": { label: "Vertical QHD", width: 1440, height: 2560, ratio: "9:16", group: "Portrait" },
  "vertical-4k": { label: "Vertical 4K", width: 2160, height: 3840, ratio: "9:16", group: "Portrait" },
  "vertical-8k": { label: "Vertical 8K", width: 4320, height: 7680, ratio: "9:16", group: "Portrait" },
  "square-hd": { label: "Square HD", width: 720, height: 720, ratio: "1:1", group: "Square" },
  "square-full-hd": { label: "Square Full HD", width: 1080, height: 1080, ratio: "1:1", group: "Square" },
  "square-4k": { label: "Square 4K", width: 2160, height: 2160, ratio: "1:1", group: "Square" },
  "square-max": { label: "Square Max", width: 4320, height: 4320, ratio: "1:1", group: "Square" },
  "social-4-5": { label: "Social Portrait", width: 1080, height: 1350, ratio: "4:5", group: "Social" },
  "social-5-4": { label: "Social Landscape", width: 1350, height: 1080, ratio: "5:4", group: "Social" },
  "classic-4-3": { label: "Classic 4:3", width: 2880, height: 2160, ratio: "4:3", group: "Classic & Cinema" },
  "classic-3-4": { label: "Classic 3:4", width: 2160, height: 2880, ratio: "3:4", group: "Classic & Cinema" },
  "dci-2k": { label: "DCI 2K", width: 2048, height: 1080, ratio: "256:135", group: "Classic & Cinema" },
  "dci-4k": { label: "DCI 4K", width: 4096, height: 2160, ratio: "256:135", group: "Classic & Cinema" },
  "cinema-21-9": { label: "Ultrawide 5K", width: 5120, height: 2160, ratio: "64:27", group: "Classic & Cinema" },
  "cinema-8k": { label: "Ultrawide 8K", width: 7680, height: 3240, ratio: "64:27", group: "Classic & Cinema" },
} as const;

export type ExportFormat = (typeof SUPPORTED_EXPORT_FORMATS)[number];
export type ExportQuality = (typeof SUPPORTED_EXPORT_QUALITIES)[number];
export type ExportFrameRate = (typeof SUPPORTED_EXPORT_FRAME_RATES)[number];
export type ExportScale = (typeof SUPPORTED_EXPORT_SCALES)[number];
export type ExportResolutionPreset = keyof typeof EXPORT_RESOLUTION_PRESETS;
export type ExportResolutionChoice = ExportScale | ExportResolutionPreset | "custom";
export type ExportAspect = "landscape" | "portrait" | "square";

export interface ExportDimensions {
  width: number;
  height: number;
}

interface ExportCompositionElement {
  getAttribute(name: string): string | null;
}

interface ExportCompositionDocument {
  querySelector(selector: string): ExportCompositionElement | null;
}

/**
 * Read the real structural composition root. DOM parsing deliberately ignores
 * tag-shaped text in comments/scripts and does not treat inert template
 * contents as the rendered entry root.
 */
export function readAuthoredExportDimensions(
  html: string,
  parseHtml?: (source: string) => ExportCompositionDocument,
): ExportDimensions | null {
  let document: ExportCompositionDocument;
  try {
    if (parseHtml) document = parseHtml(html);
    else {
      if (typeof DOMParser === "undefined") return null;
      document = new DOMParser().parseFromString(html, "text/html");
    }
  } catch {
    return null;
  }
  const root = document.querySelector("[data-composition-id]");
  if (!root) return null;
  const width = Number(root.getAttribute("data-width"));
  const height = Number(root.getAttribute("data-height"));
  return isValidExportDimensions({ width, height }) ? { width, height } : null;
}

const SDR_BT709 = {
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  range: "limited",
} as const;

const UNTAGGED_SDR_CAPTURE = {
  primaries: null,
  transfer: null,
  matrix: null,
  range: null,
} as const;

const STEREO_48K = {
  sampleRateHz: 48_000,
  channels: 2,
  optional: true,
} as const;

export const EXPORT_FORMAT_CAPABILITIES = {
  mp4: {
    label: "MP4",
    extension: ".mp4",
    mimeType: "video/mp4",
    video: {
      codec: "h264",
      hdrCodec: "h265",
      encoder: "libx264",
      hdrEncoder: "libx265",
      pixelFormat: "yuv420p",
      hdrPixelFormat: "yuv420p10le",
      profile: null,
      rateControl: "crf",
      bitrateKbps: null,
      qualityApplies: true,
    },
    audio: { codec: "aac", bitrateKbps: 192, ...STEREO_48K },
    alpha: { supported: false, bitDepth: 0 },
    color: {
      sdr: SDR_BT709,
      hdr: {
        primaries: "bt2020",
        transfers: ["smpte2084", "arib-std-b67"],
        matrix: "bt2020nc",
        range: "limited",
      },
    },
    supportsResolutionScaling: true,
  },
  webm: {
    label: "WebM",
    extension: ".webm",
    mimeType: "video/webm",
    video: {
      codec: "vp9",
      hdrCodec: null,
      encoder: "libvpx-vp9",
      hdrEncoder: null,
      pixelFormat: "yuva420p",
      hdrPixelFormat: null,
      profile: null,
      rateControl: "crf",
      bitrateKbps: null,
      qualityApplies: true,
    },
    audio: { codec: "opus", bitrateKbps: 128, ...STEREO_48K },
    alpha: { supported: true, bitDepth: 8 },
    color: { sdr: UNTAGGED_SDR_CAPTURE, hdr: null },
    supportsResolutionScaling: false,
  },
  mov: {
    label: "MOV (ProRes 4444)",
    extension: ".mov",
    mimeType: "video/quicktime",
    video: {
      codec: "prores",
      hdrCodec: null,
      encoder: "prores_ks",
      hdrEncoder: null,
      pixelFormat: "yuva444p10le",
      hdrPixelFormat: null,
      profile: "4444",
      rateControl: "fixed-profile",
      bitrateKbps: null,
      qualityApplies: false,
    },
    audio: { codec: "aac", bitrateKbps: 192, ...STEREO_48K },
    alpha: { supported: true, bitDepth: 10 },
    color: { sdr: UNTAGGED_SDR_CAPTURE, hdr: null },
    supportsResolutionScaling: false,
  },
} as const;

export const UNSUPPORTED_STANDALONE_EXPORT_FORMATS = {
  gif: "not exposed by the standalone Studio render route",
  "png-sequence": "not exposed by the standalone Studio render route",
} as const;

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && (SUPPORTED_EXPORT_FORMATS as readonly string[]).includes(value);
}

export function isExportQuality(value: unknown): value is ExportQuality {
  return typeof value === "string" && (SUPPORTED_EXPORT_QUALITIES as readonly string[]).includes(value);
}

export function isExportFrameRate(value: unknown): value is ExportFrameRate {
  return typeof value === "number" && (SUPPORTED_EXPORT_FRAME_RATES as readonly number[]).includes(value);
}

export function isExportScale(value: unknown): value is ExportScale {
  return typeof value === "string" && (SUPPORTED_EXPORT_SCALES as readonly string[]).includes(value);
}

export function isExportResolutionChoice(value: unknown): value is ExportResolutionChoice {
  return (
    isExportScale(value) ||
    value === "custom" ||
    (typeof value === "string" && value in EXPORT_RESOLUTION_PRESETS)
  );
}

export function isValidExportDimensions(value: unknown): value is ExportDimensions {
  if (typeof value !== "object" || value === null) return false;
  const { width, height } = value as Partial<ExportDimensions>;
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    (width ?? 0) > 0 &&
    (height ?? 0) > 0
  );
}

/**
 * Standalone output dimensions are codec-safe even integers. "8K" is an
 * orientation-independent envelope: the long edge may reach 7680 and the
 * short edge may reach 4320. This permits 8K portrait while preventing a
 * 7680-square frame from silently exceeding an 8K workload.
 */
export function isValidExportOutputDimensions(value: unknown): value is ExportDimensions {
  if (!isValidExportDimensions(value)) return false;
  const longEdge = Math.max(value.width, value.height);
  const shortEdge = Math.min(value.width, value.height);
  return (
    value.width % 2 === 0 &&
    value.height % 2 === 0 &&
    longEdge <= MAX_EXPORT_LONG_EDGE &&
    shortEdge <= MAX_EXPORT_SHORT_EDGE
  );
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right > 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left || 1;
}

export function exportAspectRatioLabel(dimensions: ExportDimensions): string {
  const divisor = greatestCommonDivisor(dimensions.width, dimensions.height);
  return `${dimensions.width / divisor}:${dimensions.height / divisor}`;
}

export function resolveExportTargetDimensions(
  resolution: ExportResolutionChoice,
  authoredDimensions: ExportDimensions | null | undefined,
  customDimensions?: ExportDimensions | null,
): ExportDimensions | null {
  if (resolution === "auto") {
    return isValidExportOutputDimensions(authoredDimensions) ? { ...authoredDimensions } : null;
  }
  if (resolution === "custom") {
    return isValidExportOutputDimensions(customDimensions) ? { ...customDimensions } : null;
  }
  if (resolution in EXPORT_RESOLUTION_PRESETS) {
    const preset = EXPORT_RESOLUTION_PRESETS[resolution as ExportResolutionPreset];
    return { width: preset.width, height: preset.height };
  }
  if (!isExportScale(resolution) || !isValidExportDimensions(authoredDimensions)) return null;
  return resolveExportDimensions("mp4", resolution, authoredDimensions);
}

export function compositionAspect(dimensions: ExportDimensions | null | undefined): ExportAspect {
  if (!isValidExportDimensions(dimensions)) return "landscape";
  if (dimensions.width === dimensions.height) return "square";
  return dimensions.height > dimensions.width ? "portrait" : "landscape";
}

export function normalizeExportScaleForFormat(
  format: ExportFormat,
  scale: ExportScale,
): ExportScale {
  return EXPORT_FORMAT_CAPABILITIES[format].supportsResolutionScaling ? scale : "auto";
}

export function resolveExportResolution(
  format: ExportFormat,
  scale: ExportScale,
  dimensions: ExportDimensions | null | undefined,
): CanvasResolution | "auto" {
  const normalizedScale = normalizeExportScaleForFormat(format, scale);
  if (normalizedScale === "auto" || !isValidExportDimensions(dimensions)) return "auto";
  const aspect = compositionAspect(dimensions);
  if (normalizedScale === "1080p") return aspect;
  return aspect === "landscape"
    ? "landscape-4k"
    : aspect === "portrait"
      ? "portrait-4k"
      : "square-4k";
}

export function exportScaleApplies(
  format: ExportFormat,
  scale: ExportScale,
  dimensions: ExportDimensions | null | undefined,
): boolean {
  if (scale === "auto") return true;
  if (!EXPORT_FORMAT_CAPABILITIES[format].supportsResolutionScaling) return false;
  if (!isValidExportDimensions(dimensions)) return false;
  const resolution = resolveExportResolution(format, scale, dimensions);
  if (resolution === "auto") return false;
  const target = CANVAS_DIMENSIONS[resolution];
  if (target.width * dimensions.height !== target.height * dimensions.width) return false;
  if (target.width < dimensions.width || target.height < dimensions.height) return false;
  return (
    Number.isInteger(target.width / dimensions.width) &&
    Number.isInteger(target.height / dimensions.height)
  );
}

export function resolveExportDimensions(
  format: ExportFormat,
  scale: ExportScale,
  dimensions: ExportDimensions | null | undefined,
): ExportDimensions | null {
  if (!isValidExportDimensions(dimensions)) return null;
  const resolution = resolveExportResolution(format, scale, dimensions);
  return resolution === "auto" ? { ...dimensions } : { ...CANVAS_DIMENSIONS[resolution] };
}

export function resolveEncodedDimensions(
  format: ExportFormat,
  dimensions: ExportDimensions,
): ExportDimensions | null {
  if (!isValidExportDimensions(dimensions)) return null;
  if (format === "mov") return { ...dimensions };
  const isEven = dimensions.width % 2 === 0 && dimensions.height % 2 === 0;
  if (format === "webm") return isEven ? { ...dimensions } : null;
  return {
    width: dimensions.width + (dimensions.width % 2),
    height: dimensions.height + (dimensions.height % 2),
  };
}

export function exportQualityCrf(quality: ExportQuality): number {
  return quality === "draft" ? 28 : quality === "high" ? 15 : 18;
}

export function estimateExportAudioSizeBytes(
  durationSeconds: number,
  format: ExportFormat,
  hasAudio: boolean,
): number {
  if (!hasAudio || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.round(
    (durationSeconds * EXPORT_FORMAT_CAPABILITIES[format].audio.bitrateKbps * 1000) / 8,
  );
}

export function exportFrameCount(durationSeconds: number, fps: ExportFrameRate): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const raw = durationSeconds * fps;
  const nearest = Math.round(raw);
  return Math.abs(raw - nearest) <= 1e-3 ? nearest : Math.ceil(raw);
}

export function formatExportFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  const rounded = value >= 10 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${unit}`;
}

export function validateExportSettings(input: {
  format: unknown;
  quality: unknown;
  fps: unknown;
  scale: unknown;
  dimensions: unknown;
}): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!isExportFormat(input.format)) issues.push("Unsupported export format.");
  if (!isExportQuality(input.quality)) issues.push("Unsupported export quality.");
  if (!isExportFrameRate(input.fps)) issues.push("Unsupported export frame rate.");
  if (!isExportScale(input.scale)) issues.push("Unsupported export resolution.");
  if (!isValidExportDimensions(input.dimensions)) issues.push("Invalid composition dimensions.");

  if (
    isExportFormat(input.format) &&
    isExportScale(input.scale) &&
    isValidExportDimensions(input.dimensions)
  ) {
    if (!exportScaleApplies(input.format, input.scale, input.dimensions)) {
      issues.push(
        EXPORT_FORMAT_CAPABILITIES[input.format].supportsResolutionScaling
          ? "The selected resolution is not an integer upscale of the composition."
          : `${EXPORT_FORMAT_CAPABILITIES[input.format].label} exports at native resolution.`,
      );
    }
    const outputDimensions = resolveExportDimensions(input.format, input.scale, input.dimensions);
    if (outputDimensions && !resolveEncodedDimensions(input.format, outputDimensions)) {
      issues.push(`${EXPORT_FORMAT_CAPABILITIES[input.format].label} requires even dimensions.`);
    }
  }

  return { ok: issues.length === 0, issues };
}
