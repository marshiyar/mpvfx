import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { findBundledFfBinary, type BundledFfBinaryFinder } from "./binaries";
import type { VideoFramesRequest, VideoFramesResult } from "../../shared/desktopBridge";

function run(binary: string, args: string[], signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolveRun, reject) => {
    execFile(binary, args, { encoding: "buffer", signal, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolveRun(stdout));
  });
}

let activeDecodes = 0;
const waitingDecodes: Array<() => void> = [];

function acquireDecoder(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  return new Promise((resolveSlot, reject) => {
    const begin = () => {
      signal.removeEventListener("abort", cancel);
      activeDecodes += 1;
      resolveSlot(() => {
        activeDecodes -= 1;
        waitingDecodes.shift()?.();
      });
    };
    const cancel = () => {
      const index = waitingDecodes.indexOf(begin);
      if (index !== -1) waitingDecodes.splice(index, 1);
      reject(signal.reason ?? new DOMException("Frame decoding cancelled", "AbortError"));
    };
    if (activeDecodes < 2) begin();
    else { waitingDecodes.push(begin); signal.addEventListener("abort", cancel, { once: true }); }
  });
}

/** Decode source media in the bundled native engine. No browser, DOM, or composition markup. */
export async function decodeNativeVideoFrames(
  projectRoot: string,
  request: VideoFramesRequest,
  signal: AbortSignal,
  findBinary: BundledFfBinaryFinder = findBundledFfBinary,
): Promise<VideoFramesResult> {
  const release = await acquireDecoder(signal);
  try { return await decodeFrames(projectRoot, request, signal, findBinary); }
  finally { release(); }
}

async function decodeFrames(
  projectRoot: string,
  request: VideoFramesRequest,
  signal: AbortSignal,
  findBinary: BundledFfBinaryFinder,
): Promise<VideoFramesResult> {
  if (!request || typeof request.source !== "string" || !request.source ||
      !Number.isInteger(request.frameCount) || request.frameCount < 1 || request.frameCount > 6 ||
      !Number.isInteger(request.width) || request.width < 1 || request.width > 480 ||
      !Number.isInteger(request.height) || request.height < 1 || request.height > 270 ||
      (request.sourceStart !== undefined && (!Number.isFinite(request.sourceStart) || request.sourceStart < 0)) ||
      (request.sourceRangeDuration !== undefined && (!Number.isFinite(request.sourceRangeDuration) || request.sourceRangeDuration < 0))) {
    throw new Error("Invalid video frame request");
  }
  const root = await realpath(projectRoot);
  const source = await realpath(resolve(root, request.source));
  const offset = relative(root, source);
  if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`) ||
      !/\.(mp4|mov|m4v|webm|mkv|avi|mxf)$/i.test(source) || !(await stat(source)).isFile()) {
    throw new Error("Video source must be a media file inside this project");
  }
  const ffmpeg = findBinary("ffmpeg");
  const ffprobe = findBinary("ffprobe");
  if (!ffmpeg || !ffprobe) throw new Error("Bundled media engine is unavailable");
  const metadata = JSON.parse((await run(ffprobe, [
    "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration,avg_frame_rate,sample_aspect_ratio:stream_side_data=rotation:format=duration",
    "-of", "json", source,
  ], signal)).toString("utf8"));
  const stream = metadata.streams?.[0];
  if (!(stream?.width > 0 && stream?.height > 0)) throw new Error("Video source has no decodable video track");
  const rotation = Number(stream.side_data_list?.find((data: { rotation?: number }) => data.rotation !== undefined)?.rotation ?? 0);
  const rotated = Math.abs(rotation % 180) === 90;
  const [sarWidth, sarHeight] = String(stream.sample_aspect_ratio).split(":").map(Number);
  const sar = sarWidth! / sarHeight!;
  const displayWidth = stream.width * (Number.isFinite(sar) && sar > 0 ? sar : 1);
  const aspect = rotated ? stream.height / displayWidth : displayWidth / stream.height;
  const width = Math.max(1, Math.min(request.width, Math.round(request.height * aspect)));
  const height = Math.max(1, Math.min(request.height, Math.round(width / aspect)));
  const streamDuration = Number(stream.duration);
  const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number(metadata.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Video duration is unavailable");
  const [numerator, denominator] = String(stream.avg_frame_rate).split("/").map(Number);
  const frameRate = numerator! / denominator!;
  const lastFrame = Math.max(0, duration - (Number.isFinite(frameRate) && frameRate > 0 ? 1 / frameRate : 0.1));
  const start = Math.min(request.sourceStart ?? 0, lastFrame);
  const range = Math.min(request.sourceRangeDuration ?? duration - start, duration - start);
  const frames: string[] = [];
  for (let index = 0; index < request.frameCount; index += 1) {
    const fraction = request.frameCount === 1 ? 0.5 : index / (request.frameCount - 1);
    const time = Math.min(start + range * fraction, lastFrame);
    const frame = await run(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
      "-ss", String(time), "-i", source, "-map", "0:v:0", "-frames:v", "1", "-an", "-sn",
      "-vf", `scale=${width}:${height}:out_range=full,setsar=1,format=yuvj420p`, "-threads", "1", "-c:v", "mjpeg", "-q:v", "4",
      "-f", "image2pipe", "pipe:1",
    ], signal);
    if (!frame.length) throw new Error("Video source returned no frame");
    frames.push(frame.toString("base64"));
  }
  return { duration, aspect, width, height, frames };
}
