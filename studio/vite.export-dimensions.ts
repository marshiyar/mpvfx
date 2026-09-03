import { spawn } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { parseHTMLContent } from "@hyperframes/core/compiler";
import { detectGpuEncoder, type GpuEncoder } from "@hyperframes/engine";
import {
  exportQualityCrf,
  isValidExportOutputDimensions,
  readAuthoredExportDimensions as readAuthoredDimensions,
  type ExportDimensions,
  type ExportFormat,
  type ExportQuality,
} from "./src/utils/exportPolicy";
import {
  findBundledFfBinary,
  type BundledFfBinaryFinder,
} from "./vite.bundled-media-binaries";

const DIMENSIONS_VARIABLE = "__studioExportDimensions";
export const DEFAULT_FFMPEG_CANCEL_GRACE_MS = 3_000;

export interface ExportStagingPaths {
  directory: string;
  nativeOutputPath: string;
  encodedOutputPath: string;
}

export function createExportStagingPaths(
  outputPath: string,
  jobId: string,
): ExportStagingPaths {
  const extension = extname(outputPath) || ".mp4";
  const safeJobId = jobId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const directory = join(dirname(outputPath), ".studio-render-tmp", safeJobId);
  return {
    directory,
    nativeOutputPath: join(directory, `native${extension}`),
    encodedOutputPath: join(directory, `encoded${extension}`),
  };
}

export function readAuthoredExportDimensions(html: string): ExportDimensions | null {
  return readAuthoredDimensions(html, parseHTMLContent);
}

export function assertAuthoredExportWithinLimit(html: string): void {
  const dimensions: unknown = readAuthoredExportDimensions(html);
  if (dimensions !== null && !isValidExportOutputDimensions(dimensions)) {
    const invalid = dimensions as ExportDimensions;
    throw new Error(
      `Canvas ${invalid.width}x${invalid.height} exceeds the 8K export limit`,
    );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The installed shared Studio server does not yet expose output dimensions to
 * adapters. Carry the already-validated value through its existing variables
 * object, then strip it before composition variables reach the renderer.
 */
export function injectStandaloneExportDimensions(body: Buffer | undefined): Buffer | undefined {
  if (!body) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!isPlainRecord(parsed) || !isValidExportOutputDimensions(parsed.dimensions)) return body;
  const variables = isPlainRecord(parsed.variables) ? parsed.variables : {};
  return Buffer.from(
    JSON.stringify({
      ...parsed,
      dimensions: undefined,
      variables: { ...variables, [DIMENSIONS_VARIABLE]: parsed.dimensions },
    }),
  );
}

export function takeStandaloneExportDimensions(variables: unknown): {
  dimensions: ExportDimensions | null;
  variables: Record<string, unknown> | undefined;
} {
  if (!isPlainRecord(variables)) return { dimensions: null, variables: undefined };
  const dimensions = isValidExportOutputDimensions(variables[DIMENSIONS_VARIABLE])
    ? variables[DIMENSIONS_VARIABLE]
    : null;
  const remaining = Object.fromEntries(
    Object.entries(variables).filter(([key]) => key !== DIMENSIONS_VARIABLE),
  );
  return {
    dimensions,
    variables: Object.keys(remaining).length > 0 ? remaining : undefined,
  };
}

export function buildExportResizeArgs(input: {
  format: ExportFormat;
  quality: ExportQuality;
  inputPath: string;
  outputPath: string;
  dimensions: ExportDimensions;
  gpuEncoder?: GpuEncoder;
}): string[] {
  const { width, height } = input.dimensions;
  const padColor = input.format === "mp4" ? "black" : "black@0";
  const filter =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`;
  const inputDecoder = input.format === "webm" ? ["-c:v", "libvpx-vp9"] : [];
  const common = [
    "-y",
    ...inputDecoder,
    "-i",
    input.inputPath,
    "-vf",
    filter,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
  ];
  const mp4Video =
    input.gpuEncoder === "videotoolbox"
      ? [
          "-c:v",
          "h264_videotoolbox",
          "-q:v",
          String(Math.max(0, Math.min(100, 100 - exportQualityCrf(input.quality) * 2))),
          "-allow_sw",
          "1",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
        ]
      : [
          "-c:v",
          "libx264",
          "-crf",
          String(exportQualityCrf(input.quality)),
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
        ];
  const video =
    input.format === "mp4"
      ? mp4Video
      : input.format === "webm"
        ? [
            "-c:v",
            "libvpx-vp9",
            "-crf",
            String(exportQualityCrf(input.quality)),
            "-b:v",
            "0",
            "-pix_fmt",
            "yuva420p",
          ]
        : ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"];
  return [...common, ...video, "-c:a", "copy", input.outputPath];
}

export async function resizeStandaloneExport(input: {
  format: ExportFormat;
  quality: ExportQuality;
  inputPath: string;
  outputPath: string;
  dimensions: ExportDimensions;
  signal?: AbortSignal;
}, dependencies: {
  findBinary?: BundledFfBinaryFinder;
  detectGpuEncoder?: typeof detectGpuEncoder;
  spawnProcess?: typeof spawn;
  cancelGraceMs?: number;
} = {}): Promise<void> {
  if (input.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
  const findBinary = dependencies.findBinary ?? findBundledFfBinary;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const cancelGraceMs = dependencies.cancelGraceMs ?? DEFAULT_FFMPEG_CANCEL_GRACE_MS;
  const ffmpeg = findBinary("ffmpeg", { configuredMustExist: true });
  if (!ffmpeg) throw new Error("FFmpeg is required to resize this export");
  let gpuEncoder: GpuEncoder = null;
  if (input.format === "mp4") {
    try {
      gpuEncoder = await (dependencies.detectGpuEncoder ?? detectGpuEncoder)();
    } catch {
      // Hardware acceleration is an optimization. A failed capability probe
      // must never make an otherwise valid export fail.
      gpuEncoder = null;
    }
  }
  if (input.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
  const args = buildExportResizeArgs({
    ...input,
    // This resize path currently has an audited hardware mapping for Apple's
    // VideoToolbox. Other platforms keep the portable libx264 fallback here;
    // the main producer path supports its full probed GPU matrix.
    gpuEncoder: gpuEncoder === "videotoolbox" ? gpuEncoder : null,
  });
  const runResize = (commandArgs: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawnProcess(ffmpeg, commandArgs, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
      });
      const cleanup = () => {
        settled = true;
        input.signal?.removeEventListener("abort", abort);
        if (forceKillTimer) clearTimeout(forceKillTimer);
      };
      const abort = () => {
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, Math.max(0, cancelGraceMs));
        forceKillTimer.unref?.();
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (code, signal) => {
        cleanup();
        if (input.signal?.aborted || signal) {
          reject(new DOMException("Export cancelled", "AbortError"));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg resize failed (${code ?? "unknown"}): ${stderr.trim()}`));
        }
      });
    });

  try {
    await runResize(args);
  } catch (error) {
    if (gpuEncoder !== "videotoolbox" || input.signal?.aborted) throw error;
    // Hardware availability may change after the capability probe (for
    // example, another process can occupy VideoToolbox). Retry once with the
    // portable encoder so that optimization never becomes an export failure.
    await runResize(
      buildExportResizeArgs({
        ...input,
        gpuEncoder: null,
      }),
    );
  }
}
