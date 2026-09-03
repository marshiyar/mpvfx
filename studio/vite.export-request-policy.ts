import { VALID_CANVAS_RESOLUTIONS } from "@hyperframes/parsers";
import {
  EXPORT_FORMAT_CAPABILITIES,
  isExportFormat,
  isExportFrameRate,
  isValidExportOutputDimensions,
  isExportQuality,
} from "./src/utils/exportPolicy";

const VALID_RESOLUTIONS = new Set<string>(VALID_CANVAS_RESOLUTIONS);
const UNSUPPORTED_OVERRIDE_FIELDS = [
  "codec",
  "crf",
  "videoBitrate",
  "audioBitrate",
  "colorSpace",
  "colorProfile",
  "alpha",
  "hdrMode",
  "outputDynamicRange",
  "workers",
  "gpu",
  "useGpu",
  "videoFrameFormat",
  "gifLoop",
  "outputResolution",
  "width",
  "height",
] as const;

function errorResponse(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateStandaloneExportHttpRequest(input: {
  method: string | undefined;
  requestPath: string;
  body: Buffer | Uint8Array | undefined;
}): Response | null {
  if (input.method?.toUpperCase() !== "POST") return null;
  if (!/^\/projects\/[^/]+\/render$/.test(input.requestPath)) return null;

  let parsed: unknown = {};
  if (input.body && input.body.byteLength > 0) {
    try {
      parsed = JSON.parse(Buffer.from(input.body).toString("utf8"));
    } catch {
      return errorResponse("Export request body must be valid JSON.");
    }
  }
  if (!isPlainRecord(parsed)) return errorResponse("Export request body must be a JSON object.");

  const issues: string[] = [];
  if ("format" in parsed && !isExportFormat(parsed.format)) {
    issues.push("format must be one of: mp4, webm, mov");
  }
  if ("quality" in parsed && !isExportQuality(parsed.quality)) {
    issues.push("quality must be one of: draft, standard, high");
  }
  if ("fps" in parsed && !isExportFrameRate(parsed.fps)) {
    issues.push("fps must be one of: 24, 30, 60");
  }
  if ("resolution" in parsed) {
    if (parsed.resolution === "auto") {
      issues.push('resolution "auto" must be omitted to use authored dimensions');
    } else if (typeof parsed.resolution !== "string" || !VALID_RESOLUTIONS.has(parsed.resolution)) {
      issues.push(`resolution must be one of: ${[...VALID_RESOLUTIONS].join(", ")}`);
    }
  }
  if ("dimensions" in parsed && !isValidExportOutputDimensions(parsed.dimensions)) {
    issues.push(
      "dimensions must contain even integer width and height within the 8K limit (7680 long edge, 4320 short edge)",
    );
  }
  if (parsed.resolution !== undefined && parsed.dimensions !== undefined) {
    issues.push("resolution and dimensions cannot be used together");
  }

  const format = isExportFormat(parsed.format) ? parsed.format : "mp4";
  if (
    parsed.resolution !== undefined &&
    !EXPORT_FORMAT_CAPABILITIES[format].supportsResolutionScaling
  ) {
    issues.push(`${EXPORT_FORMAT_CAPABILITIES[format].label} exports at native resolution`);
  }

  for (const field of UNSUPPORTED_OVERRIDE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(parsed, field)) {
      issues.push(`${field} is not supported by the standalone export route`);
    }
  }

  return issues.length > 0 ? errorResponse(issues.join(". ")) : null;
}
