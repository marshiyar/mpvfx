import { spawn } from "node:child_process";
import { extname } from "node:path";
import {
  DEFAULT_VP9_CPU_USED,
  extractMediaMetadata,
  renderProvenanceArgs,
} from "@hyperframes/engine";
import { findBundledFfBinary } from "../../vite.bundled-media-binaries";
import { createSession, type Session } from "./inference";
import type { Device, ModelId } from "./manager";

type OutputFormat = "webm" | "mov" | "png";
type Quality = "fast" | "balanced" | "best";
const QUALITY_CRF: Record<Quality, number> = { fast: 30, balanced: 18, best: 12 };
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export interface BackgroundRemovalOptions {
  inputPath: string;
  outputPath: string;
  backgroundOutputPath?: string;
  device?: Device;
  model?: ModelId;
  quality?: Quality;
  onProgress?: (event:
    | { kind: "info"; message: string }
    | { kind: "metadata"; width: number; height: number; fps: number; frameCount: number }
    | { kind: "frame"; index: number; total: number; avgMsPerFrame: number }) => void;
}

export function inferOutputFormat(path: string): OutputFormat {
  const extension = extname(path).toLowerCase();
  if (extension === ".webm" || extension === ".mov" || extension === ".png") return extension.slice(1) as OutputFormat;
  throw new Error("Background-removal output must be WebM, MOV, or PNG");
}

export function inferInputKind(path: string): "video" | "image" {
  const extension = extname(path).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  throw new Error("Background removal supports video and image files only");
}

export function resolveRenderTargets(
  inputPath: string,
  outputPath: string,
  backgroundOutputPath?: string,
): { format: OutputFormat; inputKind: "video" | "image"; backgroundFormat?: OutputFormat } {
  const format = inferOutputFormat(outputPath);
  const inputKind = inferInputKind(inputPath);
  if (inputKind === "image" && format !== "png") throw new Error("Image cutouts require PNG output");
  if (inputKind === "video" && format === "png") throw new Error("Video cutouts require WebM or MOV output");
  const backgroundFormat = backgroundOutputPath ? inferOutputFormat(backgroundOutputPath) : undefined;
  if (backgroundFormat === "png" || (backgroundOutputPath && inputKind === "image")) {
    throw new Error("Background plates require video WebM or MOV output");
  }
  return { format, inputKind, backgroundFormat };
}

export function buildEncoderArgs(
  format: OutputFormat,
  width: number,
  height: number,
  fps: number,
  outputPath: string,
  quality: Quality = "balanced",
): string[] {
  const base = ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps || 30), "-i", "-"];
  if (format === "webm") {
    return [...base, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(QUALITY_CRF[quality]), "-deadline", "good", "-row-mt", "1", "-cpu-used", String(DEFAULT_VP9_CPU_USED), "-auto-alt-ref", "0", "-pix_fmt", "yuva420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-metadata:s:v:0", "alpha_mode=1", "-an", ...renderProvenanceArgs(outputPath), outputPath];
  }
  if (format === "mov") {
    return [...base, "-c:v", "prores_ks", "-profile:v", "4444", "-vendor", "apl0", "-pix_fmt", "yuva444p10le", "-an", ...renderProvenanceArgs(outputPath), outputPath];
  }
  return [...base, "-frames:v", "1", "-pix_fmt", "rgba", "-update", "1", outputPath];
}

async function* readFrames(stream: NodeJS.ReadableStream, frameBytes: number): AsyncGenerator<Buffer> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffered = buffered.length === 0 ? Buffer.from(chunk as Buffer) : Buffer.concat([buffered, chunk as Buffer]);
    while (buffered.length >= frameBytes) {
      yield Buffer.from(buffered.subarray(0, frameBytes));
      buffered = buffered.subarray(frameBytes);
    }
  }
}

function spawnFfmpeg(path: string, args: string[], label: string, stdio: ["ignore" | "pipe", "ignore" | "pipe", "ignore" | "pipe"]) {
  const process = spawn(path, args, { stdio, windowsHide: true });
  let stderr = "";
  process.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
  process.stdin?.on("error", () => {});
  const exit = new Promise<void>((resolve, reject) => {
    process.on("error", reject);
    process.on("exit", (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${label} ${signal ? `was killed by ${signal}` : `exited with code ${code}`}: ${stderr.slice(-400)}`));
    });
  });
  return { process, exit, stderr: () => stderr };
}

async function runPipeline(
  options: BackgroundRemovalOptions,
  session: Session,
  media: { width: number; height: number; fps: number; frameCount: number },
  format: OutputFormat,
  backgroundFormat: OutputFormat | undefined,
  ffmpeg: string,
): Promise<number> {
  const { width, height, fps, frameCount } = media;
  const decoder = spawnFfmpeg(ffmpeg, ["-loglevel", "error", "-i", options.inputPath, "-f", "rawvideo", "-pix_fmt", "rgb24", "-an", "-"], "FFmpeg decoder", ["ignore", "pipe", "pipe"]);
  const foreground = spawnFfmpeg(ffmpeg, buildEncoderArgs(format, width, height, fps, options.outputPath, options.quality), "FFmpeg encoder", ["pipe", "ignore", "pipe"]);
  const background = options.backgroundOutputPath && backgroundFormat
    ? spawnFfmpeg(ffmpeg, buildEncoderArgs(backgroundFormat, width, height, fps, options.backgroundOutputPath, options.quality), "FFmpeg background encoder", ["pipe", "ignore", "pipe"])
    : null;
  let processed = 0;
  const recent: number[] = [];
  try {
    for await (const rgb of readFrames(decoder.process.stdout!, width * height * 3)) {
      const started = Date.now();
      const output = await session.process(rgb, width, height, Boolean(background));
      recent.push(Date.now() - started);
      if (recent.length > 30) recent.shift();
      const writes: Promise<void>[] = [];
      if (!foreground.process.stdin!.write(output.fg)) writes.push(new Promise((resolve) => foreground.process.stdin!.once("drain", resolve)));
      if (background && output.bg && !background.process.stdin!.write(output.bg)) writes.push(new Promise((resolve) => background.process.stdin!.once("drain", resolve)));
      await Promise.all(writes);
      processed++;
      options.onProgress?.({ kind: "frame", index: processed, total: frameCount, avgMsPerFrame: recent.reduce((sum, value) => sum + value, 0) / recent.length });
    }
  } catch (error) {
    decoder.process.kill("SIGKILL");
    foreground.process.kill("SIGKILL");
    background?.process.kill("SIGKILL");
    throw error;
  }
  foreground.process.stdin!.end();
  background?.process.stdin!.end();
  await Promise.all([decoder.exit, foreground.exit, ...(background ? [background.exit] : [])]);
  if (processed === 0) throw new Error(`FFmpeg decoded no frames: ${decoder.stderr().slice(-400)}`);
  return processed;
}

export async function render(options: BackgroundRemovalOptions) {
  const ffmpeg = findBundledFfBinary("ffmpeg", { configuredMustExist: true });
  const ffprobe = findBundledFfBinary("ffprobe", { configuredMustExist: true });
  if (!ffmpeg || !ffprobe) throw new Error("Bundled FFmpeg and FFprobe are unavailable");
  const { format, inputKind, backgroundFormat } = resolveRenderTargets(options.inputPath, options.outputPath, options.backgroundOutputPath);
  const metadata = await extractMediaMetadata(options.inputPath);
  const fps = inputKind === "image" ? 0 : metadata.fps || 30;
  const frameCount = inputKind === "image" ? 1 : Math.round((metadata.durationSeconds || 0) * fps);
  options.onProgress?.({ kind: "metadata", width: metadata.width, height: metadata.height, fps, frameCount });
  const session = await createSession({ model: options.model, device: options.device, onProgress: (message) => options.onProgress?.({ kind: "info", message }) });
  try {
    const started = Date.now();
    const framesProcessed = await runPipeline(options, session, { width: metadata.width, height: metadata.height, fps, frameCount }, format, backgroundFormat, ffmpeg);
    const durationSeconds = (Date.now() - started) / 1000;
    return { provider: session.provider, framesProcessed, durationSeconds, avgMsPerFrame: framesProcessed ? durationSeconds * 1000 / framesProcessed : 0 };
  } finally {
    await session.close();
  }
}
