import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { detectSilences, type SilenceRange, type SilenceRemovalOptions } from "../../shared/media/silenceDetection";
import { findBundledFfBinary, type BundledFfBinaryFinder } from "./binaries";
import { readProjectMediaMetadata } from "./metadata";

export interface SilenceAnalysisRequest {
  source: string;
  sourceStart: number;
  sourceDuration: number;
}

const SAMPLE_RATE = 16_000;
const CHUNK_SECONDS = 120;
const OVERLAP_SECONDS = 1;

function decodeChunk(binary: string, path: string, start: number, duration: number, signal: AbortSignal): Promise<Float32Array> {
  return new Promise((accept, reject) => {
    execFile(binary, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
      "-ss", String(start), "-i", path, "-t", String(duration), "-map", "0:a:0",
      "-vn", "-sn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1",
    ], { encoding: "buffer", signal, timeout: 60_000, maxBuffer: 9 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return; }
      const samples = new Float32Array(Math.floor(stdout.length / 4));
      for (let index = 0; index < samples.length; index++) samples[index] = stdout.readFloatLE(index * 4);
      accept(samples);
    });
  });
}

/** Analyze only the selected source interval. Paths remain confined to the project. */
export async function analyzeProjectVideoSilence(
  projectRoot: string,
  request: SilenceAnalysisRequest,
  signal: AbortSignal,
  findBinary: BundledFfBinaryFinder = findBundledFfBinary,
  options: Partial<SilenceRemovalOptions> = {},
): Promise<SilenceRange[]> {
  if (!request || typeof request.source !== "string" || !request.source ||
      !Number.isFinite(request.sourceStart) || request.sourceStart < 0 ||
      !Number.isFinite(request.sourceDuration) || request.sourceDuration <= 0) {
    throw new Error("Invalid silence analysis request");
  }
  signal.throwIfAborted();
  const root = await realpath(projectRoot);
  const source = await realpath(resolve(root, request.source));
  const offset = relative(root, source);
  if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`) ||
      !/\.(mp4|mov|m4v|webm|mkv|avi|mxf)$/i.test(source) || !(await stat(source)).isFile()) {
    throw new Error("Video source must be a file inside this project");
  }
  const metadata = await readProjectMediaMetadata(root, offset, signal);
  if (!metadata.hasVideo || !metadata.hasAudio) throw new Error("Selected video has no audio track");
  const ffmpeg = findBinary("ffmpeg", { configuredMustExist: true });
  if (!ffmpeg) throw new Error("MpVFX's bundled FFmpeg is unavailable");

  const duration = Math.min(request.sourceDuration, Math.max(0, metadata.duration - request.sourceStart));
  if (duration <= 0) throw new Error("Selected clip is outside the video source");
  const ranges: SilenceRange[] = [];
  for (let offsetSeconds = 0; offsetSeconds < duration; offsetSeconds += CHUNK_SECONDS - OVERLAP_SECONDS) {
    signal.throwIfAborted();
    const length = Math.min(CHUNK_SECONDS, duration - offsetSeconds);
    const samples = await decodeChunk(ffmpeg, source, request.sourceStart + offsetSeconds, length, signal);
    for (const range of detectSilences([samples], SAMPLE_RATE, options)) {
      const start = request.sourceStart + offsetSeconds + range.start;
      const end = request.sourceStart + offsetSeconds + range.end;
      const previous = ranges.at(-1);
      if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
      else ranges.push({ start, end });
    }
  }
  return ranges;
}
