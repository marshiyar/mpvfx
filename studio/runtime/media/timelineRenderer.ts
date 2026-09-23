import { execFile, spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseNativeProjectDocument, type NativeProjectDocument, type NativeProjectClip } from "../../shared/project/nativeProjectDocument";
import { exportQualityCrf, isValidExportOutputDimensions, type ExportDimensions, type ExportFormat, type ExportQuality } from "../../shared/export/exportPolicy";
import { findBundledFfBinary, type BundledFfBinaryFinder } from "./binaries";

export interface NativeTimelineRenderInput {
  project: NativeProjectDocument;
  projectDir: string;
  outputPath: string;
  format: ExportFormat;
  outputDimensions?: ExportDimensions;
  outputFps?: number;
  quality?: ExportQuality;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

interface MediaInfo { path: string; video: boolean; audio: boolean; duration: number; }
export class UnsupportedNativeMediaError extends Error {}
const STATIC_PARAMETERS = new Set([
  "transform.position", "transform.position.x", "transform.position.y", "transform.rotation",
  "transform.scale", "transform.scaleX", "transform.scaleY", "transform.opacity",
  "visual.opacity", "visual.autoAlpha", "layout.width", "layout.height", "audio.volume",
  "layout.left", "layout.top", "layout.zIndex",
]);

/** Unsupported edits are errors, never silently missing from the finished video. */
export function assertNativeTimelineSupported(project: NativeProjectDocument): void {
  if (!isValidExportOutputDimensions(project.canvas)) throw new Error("Invalid native canvas dimensions");
  if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(project.canvas.background)) {
    throw new Error("Native canvas background must be an RGB or RGBA hex color");
  }
  for (const track of project.sequence.tracks) for (const clip of track.clips) {
    const asset = project.assets.find(candidate => candidate.id === clip.assetId);
    if (!asset?.source) throw new Error(`Media path is missing for asset ${clip.assetId}`);
    if (clip.effects.some(effect => effect.enabled)) throw new Error(`Clip ${clip.id} has effects that have not been migrated to the native renderer`);
    if (clip.parameterTracks.length) throw new Error(`Clip ${clip.id} has animation that has not been migrated to the native renderer`);
    for (const [id, value] of Object.entries(clip.staticParameters ?? {})) {
      if (!STATIC_PARAMETERS.has(id)) throw new Error(`Native renderer does not support ${id} on clip ${clip.id}`);
      const vector = id === "transform.position" || id === "transform.scale";
      if (typeof value !== "number" && !(vector && "x" in value)) throw new Error(`Invalid native parameter ${id}`);
    }
  }
}

async function probeMedia(root: string, source: string, ffprobe: string, signal?: AbortSignal): Promise<MediaInfo> {
  // Sources in the document are decoded, project-relative filesystem paths.
  if (isAbsolute(source) || /^[a-z][a-z\d+.-]*:/i.test(source)) throw new Error("Native media must be a project-relative file");
  const path = await realpath(resolve(root, source));
  const offset = relative(root, path);
  if (!offset || isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`) || !(await stat(path)).isFile()) {
    throw new Error("Native media must be inside its project");
  }
  signal?.throwIfAborted();
  const output = await new Promise<string>((resolveProbe, reject) => {
    execFile(ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries",
      "stream=codec_type,color_transfer,color_primaries:format=duration", "-of", "json", path],
    { encoding: "utf8", signal, timeout: 30_000, maxBuffer: 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolveProbe(stdout));
  });
  const { streams, format } = JSON.parse(output) as { format?: { duration?: string }; streams: Array<{ codec_type: string; color_transfer?: string; color_primaries?: string }> };
  if (streams.some(stream => ["smpte2084", "arib-std-b67"].includes(stream.color_transfer ?? "") || stream.color_primaries === "bt2020")) {
    throw new UnsupportedNativeMediaError("Native timeline export requires SDR media until its HDR color pipeline is implemented");
  }
  return { path, video: streams.some(stream => stream.codec_type === "video"), audio: streams.some(stream => stream.codec_type === "audio"), duration: Number(format?.duration) };
}

function number(clip: NativeProjectClip, key: string, fallback: number): number {
  const value = clip.staticParameters?.[key];
  return typeof value === "number" ? value : fallback;
}

function tempoFilters(rate: number): string[] {
  const filters: string[] = [];
  while (rate > 2) { filters.push("atempo=2"); rate /= 2; }
  while (rate < 0.5) { filters.push("atempo=0.5"); rate *= 2; }
  if (rate !== 1) filters.push(`atempo=${rate}`);
  return filters;
}

/** Build a frame/audio graph from timeline data. No DOM, HTML, GSAP, or browser calls. */
function timelineArgs(input: NativeTimelineRenderInput, media: Map<string, MediaInfo>): { args: string[]; duration: number } {
  const { project } = input;
  const fps = project.frameRate.numerator / project.frameRate.denominator;
  const outputFps = input.outputFps ?? fps;
  const { width, height } = project.canvas;
  const clips = project.sequence.tracks.flatMap((track, index) => track.clips.map(clip => ({
    clip, layer: number(clip, "layout.zIndex", track.lane?.authoredTrack ?? index),
  }))).sort((a, b) => a.layer - b.layer || a.clip.startFrame - b.clip.startFrame || a.clip.id.localeCompare(b.clip.id));
  const duration = Math.max(1, project.sequence.durationFrames ?? 0, ...clips.map(({ clip }) => clip.startFrame + clip.durationFrames)) / fps;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-filter_complex_threads", "1"];
  const background = project.canvas.background.slice(1);
  const filters = [`color=c=0x${background}:s=${width}x${height}:r=${outputFps}:d=${duration},format=rgba[base]`];
  let picture = "base";
  const audio: string[] = [];
  for (const [index, { clip }] of clips.entries()) {
    const asset = project.assets.find(candidate => candidate.id === clip.assetId)!;
    const info = media.get(asset.id)!;
    const start = clip.startFrame / fps;
    const length = clip.durationFrames / fps;
    const sourceStart = clip.sourceInFrame / fps;
    const rate = (clip.playbackRate?.numerator ?? 1) / (clip.playbackRate?.denominator ?? 1);
    if (asset.kind !== "audio" && !info.video) throw new Error(`No picture track in ${asset.name}`);
    if (asset.kind === "audio" && !info.audio) throw new Error(`No audio track in ${asset.name}`);
    if (asset.kind !== "image" && (!Number.isFinite(info.duration) || sourceStart + length * rate > info.duration + 1 / fps)) {
      throw new Error(`Clip ${clip.id} extends beyond its media file`);
    }
    args.push("-protocol_whitelist", "file,pipe");
    if (asset.kind === "image") args.push("-loop", "1", "-framerate", String(outputFps));
    else args.push("-ss", String(sourceStart));
    args.push("-t", String(length * rate), "-i", info.path);
    if (asset.kind !== "audio") {
      const position = clip.staticParameters?.["transform.position"];
      const scale = clip.staticParameters?.["transform.scale"];
      const scaleX = number(clip, "transform.scaleX", typeof scale === "number" ? scale : scale && "x" in scale ? scale.x : 1);
      const scaleY = number(clip, "transform.scaleY", typeof scale === "number" ? scale : scale && "y" in scale ? scale.y : 1);
      const boxWidth = number(clip, "layout.width", width);
      const boxHeight = number(clip, "layout.height", height);
      if (boxWidth <= 0 || boxHeight <= 0 || Math.abs(scaleX) < 0.000001 || Math.abs(scaleY) < 0.000001) {
        // Consume the input even when its authored picture has zero area.
        filters.push(`[${index}:v:0]nullsink`);
      } else {
        const scaledWidth = Math.max(1, Math.round(boxWidth * Math.abs(scaleX)));
        const scaledHeight = Math.max(1, Math.round(boxHeight * Math.abs(scaleY)));
        if (scaledWidth > 16384 || scaledHeight > 16384) throw new Error("Native clip transform exceeds the rendering size limit");
        const x = number(clip, "layout.left", 0) + number(clip, "transform.position.x", position && typeof position === "object" && "x" in position ? position.x : 0);
        const y = number(clip, "layout.top", 0) + number(clip, "transform.position.y", position && typeof position === "object" && "y" in position ? position.y : 0);
        const opacity = Math.min(1, Math.max(0, number(clip, "transform.opacity", number(clip, "visual.opacity", number(clip, "visual.autoAlpha", 1)))));
        const angle = number(clip, "transform.rotation", 0) * Math.PI / 180;
        const visual = [
          `setpts=(PTS-STARTPTS)/${rate}`, `fps=${outputFps}`, "format=rgba",
          `scale=${boxWidth}:${boxHeight}:force_original_aspect_ratio=decrease:reset_sar=1`,
          `pad=${boxWidth}:${boxHeight}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
          `scale=${scaledWidth}:${scaledHeight}`, "setsar=1",
          ...(scaleX < 0 ? ["hflip"] : []), ...(scaleY < 0 ? ["vflip"] : []),
          ...(angle ? [`rotate=${angle}:ow=rotw(${angle}):oh=roth(${angle}):c=black@0`] : []),
          `colorchannelmixer=aa=${opacity}`, `setpts=PTS+${start}/TB`,
        ];
        filters.push(`[${index}:v:0]${visual.join(",")}[clip${index}]`);
        // Scale and rotation are centered on the authored media box.
        filters.push(`[${picture}][clip${index}]overlay=x='${x}+(${boxWidth}-w)/2':y='${y}+(${boxHeight}-h)/2':eof_action=pass:repeatlast=0:format=auto:enable='gte(t,${start})*lt(t,${start + length})'[layer${index}]`);
        picture = `layer${index}`;
      }
    }
    if (info.audio && !clip.muted && asset.kind !== "image") {
      const volume = Math.max(0, number(clip, "audio.volume", 1));
      const chain = ["asetpts=PTS-STARTPTS", ...tempoFilters(rate), `atrim=duration=${length}`,
        "aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo", `volume=${volume}`,
        `adelay=${Math.round(start * 48000)}S:all=1`];
      filters.push(`[${index}:a:0]${chain.join(",")}[audio${index}]`);
      audio.push(`[audio${index}]`);
    }
  }
  const output = input.outputDimensions ?? project.canvas;
  filters.push(`[${picture}]scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2:color=${input.format === "mp4" ? "black" : "black@0"},setsar=1[outv]`);
  if (audio.length) filters.push(`${audio.join("")}amix=inputs=${audio.length}:duration=longest:normalize=0,apad,atrim=duration=${duration}[outa]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[outv]");
  if (audio.length) args.push("-map", "[outa]", "-c:a", input.format === "webm" ? "libopus" : "aac", "-b:a", "192k");
  const crf = String(exportQualityCrf(input.quality ?? "standard"));
  if (input.format === "mp4") args.push("-c:v", "libx264", "-preset", input.quality === "draft" ? "ultrafast" : "medium", "-crf", crf, "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  else if (input.format === "webm") args.push("-c:v", "libvpx-vp9", "-crf", crf, "-b:v", "0", "-pix_fmt", "yuva420p");
  else args.push("-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le");
  args.push("-t", String(duration), "-r", String(outputFps), "-fps_mode", "cfr", "-progress", "pipe:2", input.outputPath);
  return { args, duration };
}

export async function renderNativeTimeline(
  input: NativeTimelineRenderInput,
  findBinary: BundledFfBinaryFinder = findBundledFfBinary,
): Promise<void> {
  input.signal?.throwIfAborted();
  const existingOutput = await lstat(input.outputPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  });
  if (existingOutput) throw new Error("Native render output already exists");
  const project = parseNativeProjectDocument(input.project);
  assertNativeTimelineSupported(project);
  if (input.outputDimensions && !isValidExportOutputDimensions(input.outputDimensions)) throw new Error("Invalid native output dimensions");
  if (input.outputFps !== undefined && (!Number.isFinite(input.outputFps) || input.outputFps <= 0 || input.outputFps > 240)) throw new Error("Invalid native output frame rate");
  const ffmpeg = findBinary("ffmpeg");
  const ffprobe = findBinary("ffprobe");
  if (!ffmpeg || !ffprobe) throw new Error("Bundled native media engine is unavailable");
  const root = await realpath(input.projectDir);
  const usedAssets = new Set(project.sequence.tracks.flatMap(track => track.clips.map(clip => clip.assetId)));
  const media = new Map<string, MediaInfo>();
  for (const asset of project.assets) if (usedAssets.has(asset.id)) {
    media.set(asset.id, await probeMedia(root, asset.source!, ffprobe, input.signal));
  }
  const { args, duration } = timelineArgs({ ...input, project }, media);
  input.signal?.throwIfAborted();
  await new Promise<void>((resolveRender, reject) => {
    const child = spawn(ffmpeg, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let pending = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      timer.unref();
    };
    const cleanup = () => { input.signal?.removeEventListener("abort", abort); if (timer) clearTimeout(timer); };
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = (lines.pop() ?? "").slice(-4000);
      for (const line of lines) if (line.startsWith("out_time_us=")) {
        const seconds = Number(line.slice(12)) / 1_000_000;
        if (Number.isFinite(seconds)) input.onProgress?.(Math.max(0, Math.min(99.9, seconds / duration * 100)));
      }
    });
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (input.signal?.aborted) reject(input.signal.reason ?? new DOMException("Export cancelled", "AbortError"));
      else if (code !== 0) reject(new Error(`Native timeline render failed: ${stderr.trim()}`));
      else { input.onProgress?.(100); resolveRender(); }
    });
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
  });
}
