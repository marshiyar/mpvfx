import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parseHTMLContent } from "@hyperframes/core/compiler";
import { detectGpuEncoder, type GpuEncoder } from "@hyperframes/engine";
import {
  exportQualityCrf,
  isValidExportOutputDimensions,
  type ExportDimensions,
  type ExportFormat,
  type ExportQuality,
} from "./src/utils/exportPolicy";
import {
  findBundledFfBinary,
  type BundledFfBinaryFinder,
} from "./vite.bundled-media-binaries";

export const DEFAULT_DIRECT_EXPORT_CANCEL_GRACE_MS = 3_000;

export interface DirectMediaProbeStream {
  codecType: string;
  codecName: string;
  width?: number;
  height?: number;
  frameRate?: number;
  pixelFormat?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  colorSpace?: string;
  colorRange?: string;
}

export interface DirectMediaProbe {
  duration: number;
  streams: DirectMediaProbeStream[];
}

export interface DirectMediaExportInput {
  html: string;
  projectDir: string;
  outputPath: string;
  format: ExportFormat;
  fps: number;
  quality?: ExportQuality;
  dimensions: ExportDimensions;
  /** Final encoded dimensions; defaults to the authored canvas dimensions. */
  outputDimensions?: ExportDimensions;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

type SpawnProcess = typeof spawn;
type FindBinary = BundledFfBinaryFinder;
type ProbeMedia = (
  ffprobePath: string,
  mediaPath: string,
  signal?: AbortSignal,
) => Promise<DirectMediaProbe | null>;

export interface DirectMediaExportDependencies {
  findBinary?: FindBinary;
  detectGpuEncoder?: typeof detectGpuEncoder;
  probeMedia?: ProbeMedia;
  spawnProcess?: SpawnProcess;
  resolveRealPath?: (path: string) => Promise<string>;
  statPath?: typeof stat;
  cancelGraceMs?: number;
}

interface EligibleComposition {
  src: string;
  duration: number;
  sourceStart: number;
}

function abortError(): DOMException {
  return new DOMException("Export cancelled", "AbortError");
}

function finiteAttribute(element: Element, name: string): number | null {
  const value = element.getAttribute(name);
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function near(left: number, right: number, tolerance = 0.000_001): boolean {
  return Math.abs(left - right) <= tolerance;
}

function parseStyle(style: string): Map<string, string> | null {
  const entries = new Map<string, string>();
  for (const declaration of style.split(";")) {
    if (!declaration.trim()) continue;
    const separator = declaration.indexOf(":");
    if (separator < 1) return null;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim().toLowerCase();
    if (!property || !value || entries.has(property)) return null;
    entries.set(property, value);
  }
  return entries;
}

function pixelValue(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^(-?(?:\d+\.?\d*|\.\d+))(?:px)?$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFullCanvasVideoStyle(
  value: string | null,
  dimensions: ExportDimensions,
): boolean {
  if (!value) return false;
  const declarations = parseStyle(value);
  if (!declarations) return false;
  const allowed = new Set([
    "position",
    "left",
    "top",
    "width",
    "height",
    "object-fit",
    "z-index",
  ]);
  if ([...declarations.keys()].some((property) => !allowed.has(property))) return false;
  if (declarations.get("position") !== "absolute") return false;
  if (!near(pixelValue(declarations.get("left")) ?? Number.NaN, 0)) return false;
  if (!near(pixelValue(declarations.get("top")) ?? Number.NaN, 0)) return false;
  if (!near(pixelValue(declarations.get("width")) ?? Number.NaN, dimensions.width)) return false;
  if (!near(pixelValue(declarations.get("height")) ?? Number.NaN, dimensions.height)) return false;
  if (declarations.get("object-fit") !== "contain") return false;
  const zIndex = declarations.get("z-index");
  return zIndex == null || /^-?\d+$/.test(zIndex);
}

function isSolidCssColor(value: string): boolean {
  return (
    /^(?:#[0-9a-f]{3,8}|[a-z]+)$/i.test(value) ||
    /^(?:rgb|rgba|hsl|hsla)\([^()]+\)$/i.test(value)
  );
}

function hasOnlyBoilerplateStyles(
  document: Document,
  dimensions: ExportDimensions,
): boolean {
  if (document.querySelector('link[rel~="stylesheet"]')) return false;
  for (const style of document.querySelectorAll("style")) {
    const css = style.textContent ?? "";
    if (/\/\*|@|animation|transition|transform|filter|opacity/i.test(css)) return false;
    const blocks = css.split("}");
    for (const block of blocks) {
      if (!block.trim()) continue;
      const open = block.indexOf("{");
      if (open < 1) return false;
      const selectors = block
        .slice(0, open)
        .split(",")
        .map((selector) => selector.trim().toLowerCase())
        .filter(Boolean);
      if (
        selectors.length === 0 ||
        selectors.some((selector) => selector !== "html" && selector !== "body" && selector !== "#root")
      ) {
        return false;
      }
      const declarations = parseStyle(block.slice(open + 1));
      if (!declarations) return false;
      for (const [property, value] of declarations) {
        if (property === "width") {
          if (!near(pixelValue(value) ?? Number.NaN, dimensions.width)) return false;
        } else if (property === "height") {
          if (!near(pixelValue(value) ?? Number.NaN, dimensions.height)) return false;
        } else if (property === "margin") {
          if (!/^(?:0|0px)$/.test(value)) return false;
        } else if (property === "overflow") {
          if (value !== "hidden") return false;
        } else if (property === "position") {
          if (value !== "relative") return false;
        } else if (property === "background" || property === "background-color") {
          if (!isSolidCssColor(value)) return false;
        } else {
          return false;
        }
      }
    }
  }
  return true;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasOnlyBoilerplateScripts(document: Document, compositionId: string): boolean {
  const escapedId = escapeRegex(compositionId);
  const timelineSetup = new RegExp(
    `^(?:window\\.__timelines\\s*=\\s*window\\.__timelines\\s*\\|\\|\\s*\\{\\}\\s*;?\\s*)?` +
      `window\\.__timelines\\[(?:"${escapedId}"|'${escapedId}')\\]\\s*=\\s*` +
      `gsap\\.timeline\\(\\{\\s*paused\\s*:\\s*true\\s*\\}\\)\\s*;?$`,
  );
  for (const script of document.querySelectorAll("script")) {
    const src = script.getAttribute("src");
    if (src) {
      if (src !== "vendor/gsap.min.js" && src !== "./vendor/gsap.min.js") return false;
      if ((script.textContent ?? "").trim()) return false;
      continue;
    }
    const body = (script.textContent ?? "").trim();
    if (!body || !timelineSetup.test(body)) return false;
  }
  return true;
}

function readEligibleComposition(input: DirectMediaExportInput): EligibleComposition | null {
  if (input.format !== "mp4" || !Number.isFinite(input.fps) || input.fps <= 0) return null;
  let document: Document;
  try {
    document = parseHTMLContent(input.html);
  } catch {
    return null;
  }
  if (document.querySelector("base")) return null;
  const roots = [...document.querySelectorAll("[data-composition-id]")];
  if (roots.length !== 1) return null;
  const root = roots[0]!;
  if (root.parentElement !== document.body) return null;
  for (const node of document.body.childNodes) {
    if (node === root || node.nodeType === 8) continue;
    if (node.nodeType === 3 && !(node.textContent ?? "").trim()) continue;
    if (
      node.nodeType === 1 &&
      (node as Element).tagName &&
      ["script", "style"].includes((node as Element).tagName.toLowerCase())
    ) {
      continue;
    }
    return null;
  }
  const allowedRootAttributes = new Set([
    "id",
    "data-hf-id",
    "data-composition-id",
    "data-start",
    "data-duration",
    "data-width",
    "data-height",
  ]);
  if (
    [...root.attributes].some(
      (attribute) => !allowedRootAttributes.has(attribute.name.toLowerCase()),
    ) ||
    document.body.attributes.length > 0 ||
    [...document.documentElement.attributes].some(
      (attribute) => attribute.name.toLowerCase() !== "lang",
    )
  ) {
    return null;
  }
  const compositionId = root.getAttribute("data-composition-id")?.trim();
  if (!compositionId) return null;
  if (!near(finiteAttribute(root, "data-start") ?? 0, 0)) return null;
  if (
    !near(finiteAttribute(root, "data-width") ?? Number.NaN, input.dimensions.width) ||
    !near(finiteAttribute(root, "data-height") ?? Number.NaN, input.dimensions.height)
  ) {
    return null;
  }
  const rootDuration = finiteAttribute(root, "data-duration");
  if (rootDuration == null || rootDuration <= 0) return null;

  const children = [...root.children];
  if (children.length !== 1 || children[0]!.tagName.toLowerCase() !== "video") return null;
  const video = children[0]!;
  if (video.children.length > 0) return null;
  if (!video.classList.contains("clip")) return null;
  if (document.querySelectorAll("video, audio, img").length !== 1) return null;
  if (document.querySelector("[data-composition-src]")) return null;
  const timed = [...document.querySelectorAll("[data-start], [data-duration]")];
  if (timed.some((element) => element !== root && element !== video)) return null;

  const allowedAttributes = new Set([
    "id",
    "data-hf-id",
    "class",
    "src",
    "data-start",
    "data-duration",
    "data-track-index",
    "data-source-duration",
    "data-has-audio",
    "data-volume",
    "data-playback-start",
    "data-media-start",
    "data-playback-rate",
    "playsinline",
    "style",
  ]);
  if ([...video.attributes].some((attribute) => !allowedAttributes.has(attribute.name.toLowerCase()))) {
    return null;
  }
  const hasAudio = video.getAttribute("data-has-audio");
  if (hasAudio !== null && hasAudio !== "true") return null;
  if (!near(finiteAttribute(video, "data-start") ?? Number.NaN, 0)) return null;
  const playbackStartAttribute = video.getAttribute("data-playback-start");
  const legacyMediaStartAttribute = video.getAttribute("data-media-start");
  const playbackStart = playbackStartAttribute === null
    ? null
    : finiteAttribute(video, "data-playback-start");
  const legacyMediaStart = legacyMediaStartAttribute === null
    ? null
    : finiteAttribute(video, "data-media-start");
  if (
    (playbackStartAttribute !== null && (playbackStart === null || playbackStart < 0)) ||
    (legacyMediaStartAttribute !== null && (legacyMediaStart === null || legacyMediaStart < 0)) ||
    (playbackStart !== null && legacyMediaStart !== null && !near(playbackStart, legacyMediaStart))
  ) {
    return null;
  }
  const sourceStart = playbackStart ?? legacyMediaStart ?? 0;
  if (
    video.hasAttribute("data-playback-rate") &&
    !near(finiteAttribute(video, "data-playback-rate") ?? Number.NaN, 1)
  ) {
    return null;
  }
  const videoDuration = finiteAttribute(video, "data-duration");
  if (videoDuration == null || videoDuration <= 0 || !near(videoDuration, rootDuration)) return null;
  const volume = finiteAttribute(video, "data-volume");
  if (video.hasAttribute("data-volume") && (volume == null || !near(volume, 1))) return null;
  if (!isFullCanvasVideoStyle(video.getAttribute("style"), input.dimensions)) return null;
  if (
    !hasOnlyBoilerplateStyles(document, input.dimensions) ||
    !hasOnlyBoilerplateScripts(document, compositionId)
  ) {
    return null;
  }
  const src = video.getAttribute("src")?.trim();
  if (!src || /^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(src) || src.includes("?") || src.includes("#")) {
    return null;
  }
  return { src, duration: videoDuration, sourceStart };
}

function parseFrameRate(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const [numerator, denominator = "1"] = value.split("/");
  const top = Number(numerator);
  const bottom = Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return undefined;
  return top / bottom;
}

async function defaultProbeMedia(
  ffprobePath: string,
  mediaPath: string,
  signal: AbortSignal | undefined,
  spawnProcess: SpawnProcess,
  cancelGraceMs: number,
): Promise<DirectMediaProbe | null> {
  if (signal?.aborted) throw abortError();
  return new Promise((resolveProbe, reject) => {
    const child = spawnProcess(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,pix_fmt,color_transfer,color_primaries,color_space,color_range",
        "-of",
        "json",
        mediaPath,
      ],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    const cleanup = () => {
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    const abort = () => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, Math.max(0, cancelGraceMs));
      forceKillTimer.unref?.();
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      if (signal?.aborted) return reject(abortError());
      if (code !== 0) return resolveProbe(null);
      try {
        const parsed = JSON.parse(stdout) as {
          format?: { duration?: string };
          streams?: Array<Record<string, unknown>>;
        };
        const duration = Number(parsed.format?.duration);
        const streams = (parsed.streams ?? []).map((stream) => ({
          codecType: String(stream.codec_type ?? ""),
          codecName: String(stream.codec_name ?? ""),
          width: typeof stream.width === "number" ? stream.width : undefined,
          height: typeof stream.height === "number" ? stream.height : undefined,
          frameRate:
            parseFrameRate(stream.avg_frame_rate) ?? parseFrameRate(stream.r_frame_rate),
          pixelFormat:
            typeof stream.pix_fmt === "string" ? stream.pix_fmt : undefined,
          colorTransfer:
            typeof stream.color_transfer === "string" ? stream.color_transfer : undefined,
          colorPrimaries:
            typeof stream.color_primaries === "string" ? stream.color_primaries : undefined,
          colorSpace:
            typeof stream.color_space === "string" ? stream.color_space : undefined,
          colorRange:
            typeof stream.color_range === "string" ? stream.color_range : undefined,
        }));
        resolveProbe(Number.isFinite(duration) ? { duration, streams } : null);
      } catch {
        resolveProbe(null);
      }
    });
  });
}

const SAFE_SDR_PIXEL_FORMATS = new Set([
  "yuv420p",
  "nv12",
  "nv21",
  "yuv422p",
  "yuv444p",
  "uyvy422",
  "yuyv422",
  "rgb24",
  "bgr24",
]);

function isUnknownColorTag(value: string | undefined): boolean {
  return value == null || value === "" || value === "unknown" || value === "unspecified";
}

function hasSafeSdrColorMetadata(video: DirectMediaProbeStream): boolean {
  const pixelFormat = video.pixelFormat?.toLowerCase();
  if (pixelFormat && !SAFE_SDR_PIXEL_FORMATS.has(pixelFormat)) return false;
  for (const tag of [video.colorTransfer, video.colorPrimaries, video.colorSpace]) {
    const normalized = tag?.toLowerCase();
    if (!isUnknownColorTag(normalized) && normalized !== "bt709") return false;
  }
  const range = video.colorRange?.toLowerCase();
  return isUnknownColorTag(range) || range === "tv" || range === "limited";
}

function isTranscodableProbe(
  probe: DirectMediaProbe,
  input: DirectMediaExportInput,
  duration: number,
  sourceStart: number,
): boolean {
  const videos = probe.streams.filter((stream) => stream.codecType === "video");
  const audio = probe.streams.filter((stream) => stream.codecType === "audio");
  if (probe.streams.some((stream) => stream.codecType !== "video" && stream.codecType !== "audio")) {
    return false;
  }
  if (videos.length !== 1 || audio.length > 1) return false;
  const video = videos[0]!;
  if (
    !Number.isFinite(video.width) ||
    !Number.isFinite(video.height) ||
    (video.width ?? 0) <= 0 ||
    (video.height ?? 0) <= 0
  ) {
    return false;
  }
  // This path produces SDR BT.709. Known HDR/wide-gamut/high-bit-depth input
  // must stay on the complete renderer until a real tone-map is available;
  // merely stamping BT.709 metadata would corrupt its color.
  if (!hasSafeSdrColorMetadata(video)) return false;
  // A different aspect ratio would expose the composition's CSS background
  // around object-fit:contain media. Leave that visual decision to the full
  // renderer; same-aspect sources are safe to scale directly.
  if (
    !near(
      (video.width ?? 0) / (video.height ?? 1),
      input.dimensions.width / input.dimensions.height,
      0.000_001,
    )
  ) {
    return false;
  }
  const durationTolerance = Math.max(0.05, 1 / input.fps + 0.005);
  return sourceStart + duration <= probe.duration + durationTolerance;
}

async function resolveContainedMediaPath(
  projectDir: string,
  src: string,
  resolveRealPath: (path: string) => Promise<string>,
  statPath: typeof stat,
): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    return null;
  }
  if (isAbsolute(decoded)) return null;
  try {
    const projectRoot = await resolveRealPath(projectDir);
    const mediaPath = await resolveRealPath(resolve(projectRoot, decoded));
    const relation = relative(projectRoot, mediaPath);
    if (!relation || relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relation)) {
      return null;
    }
    if (!(await statPath(mediaPath)).isFile()) return null;
    return mediaPath;
  } catch {
    return null;
  }
}

function buildDirectTranscodeArgs(
  mediaPath: string,
  input: DirectMediaExportInput,
  duration: number,
  sourceStart: number,
  gpuEncoder: GpuEncoder,
): string[] {
  const quality = input.quality ?? "standard";
  const crf = exportQualityCrf(quality);
  const { width, height } = input.outputDimensions ?? input.dimensions;
  const filter =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  const videoEncoder =
    gpuEncoder === "videotoolbox"
      ? [
          "-c:v",
          "h264_videotoolbox",
          "-q:v",
          String(Math.max(0, Math.min(100, 100 - crf * 2))),
          "-allow_sw",
          "1",
        ]
      : [
          "-c:v",
          "libx264",
          "-preset",
          quality === "draft" ? "ultrafast" : quality === "high" ? "slow" : "medium",
          "-crf",
          String(crf),
        ];
  return [
    "-y",
    "-nostats",
    ...(sourceStart > 0 ? ["-ss", String(sourceStart)] : []),
    "-i",
    mediaPath,
    "-t",
    String(duration),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    filter,
    "-r",
    String(input.fps),
    "-fps_mode",
    "cfr",
    ...videoEncoder,
    "-pix_fmt",
    "yuv420p",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-color_range",
    "tv",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:2",
    input.outputPath,
  ];
}

async function runTranscodeAttempt(
  ffmpegPath: string,
  mediaPath: string,
  input: DirectMediaExportInput,
  duration: number,
  sourceStart: number,
  gpuEncoder: GpuEncoder,
  spawnProcess: SpawnProcess,
  cancelGraceMs: number,
  reportProgress: (percent: number) => void,
): Promise<void> {
  if (input.signal?.aborted) throw abortError();
  await new Promise<void>((resolveRun, reject) => {
    const child = spawnProcess(
      ffmpegPath,
      buildDirectTranscodeArgs(mediaPath, input, duration, sourceStart, gpuEncoder),
      { shell: false, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    let progressBuffer = "";
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = `${stderr}${text}`.slice(-4_000);
      progressBuffer += text;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = line.match(/^out_time_us=(\d+)$/);
        if (!match) continue;
        const elapsedSeconds = Number(match[1]) / 1_000_000;
        if (!Number.isFinite(elapsedSeconds)) continue;
        reportProgress(
          Math.min(99.9, Math.max(0, Math.round((elapsedSeconds / duration) * 1_000) / 10)),
        );
      }
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
      if (input.signal?.aborted) return reject(abortError());
      if (signal || code !== 0) {
        return reject(
          new Error(`Direct FFmpeg export failed (${signal ?? code ?? "unknown"}): ${stderr.trim()}`),
        );
      }
      resolveRun();
    });
  });
}

async function runDirectTranscode(
  ffmpegPath: string,
  mediaPath: string,
  input: DirectMediaExportInput,
  duration: number,
  sourceStart: number,
  gpuEncoder: GpuEncoder,
  spawnProcess: SpawnProcess,
  cancelGraceMs: number,
): Promise<void> {
  let highestProgress = 0;
  const reportProgress = (percent: number) => {
    highestProgress = Math.max(highestProgress, percent);
    input.onProgress?.(highestProgress);
  };
  reportProgress(0);
  if (gpuEncoder === "videotoolbox") {
    try {
      await runTranscodeAttempt(
        ffmpegPath,
        mediaPath,
        input,
        duration,
        sourceStart,
        gpuEncoder,
        spawnProcess,
        cancelGraceMs,
        reportProgress,
      );
      reportProgress(100);
      return;
    } catch (error) {
      if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw abortError();
      }
      // A capability probe can become stale (driver pressure, codec-specific
      // failure). Retry directly in software instead of falling all the way
      // back to thousands of browser frame captures.
    }
  }
  await runTranscodeAttempt(
    ffmpegPath,
    mediaPath,
    input,
    duration,
    sourceStart,
    null,
    spawnProcess,
    cancelGraceMs,
    reportProgress,
  );
  reportProgress(100);
}

/**
 * Attempt the browser-free export path for a single full-canvas clip whose
 * only optional edit is an in/out trim at normal playback speed.
 * FFmpeg normalizes dimensions, CFR, quality, color tags, and audio without
 * capturing every frame through Chromium. `false` is a normal fail-closed
 * result: callers use the full renderer for every edited or uncertain case.
 */
export async function tryDirectMediaExport(
  input: DirectMediaExportInput,
  dependencies: DirectMediaExportDependencies = {},
): Promise<boolean> {
  if (input.signal?.aborted) throw abortError();
  if (
    !isValidExportOutputDimensions(input.dimensions) ||
    (input.outputDimensions && !isValidExportOutputDimensions(input.outputDimensions))
  ) {
    return false;
  }
  const eligible = readEligibleComposition(input);
  if (!eligible) return false;
  const resolveRealPath = dependencies.resolveRealPath ?? realpath;
  const mediaPath = await resolveContainedMediaPath(
    input.projectDir,
    eligible.src,
    resolveRealPath,
    dependencies.statPath ?? stat,
  );
  if (!mediaPath) return false;
  const findBinary = dependencies.findBinary ?? findBundledFfBinary;
  const ffmpegPath = findBinary("ffmpeg", { configuredMustExist: true });
  const ffprobePath = findBinary("ffprobe", { configuredMustExist: true });
  if (!ffmpegPath || !ffprobePath) return false;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const cancelGraceMs = dependencies.cancelGraceMs ?? DEFAULT_DIRECT_EXPORT_CANCEL_GRACE_MS;
  let probe: DirectMediaProbe | null;
  try {
    probe = await (dependencies.probeMedia
      ? dependencies.probeMedia(ffprobePath, mediaPath, input.signal)
      : defaultProbeMedia(
          ffprobePath,
          mediaPath,
          input.signal,
          spawnProcess,
          cancelGraceMs,
        ));
  } catch (error) {
    if (input.signal?.aborted) throw abortError();
    return false;
  }
  if (!probe || !isTranscodableProbe(probe, input, eligible.duration, eligible.sourceStart)) {
    return false;
  }
  let gpuEncoder: GpuEncoder = null;
  try {
    gpuEncoder = await (dependencies.detectGpuEncoder ?? detectGpuEncoder)();
  } catch {
    // Hardware acceleration is an optimization, never an export prerequisite.
    gpuEncoder = null;
  }
  if (input.signal?.aborted) throw abortError();
  await runDirectTranscode(
    ffmpegPath,
    mediaPath,
    input,
    eligible.duration,
    eligible.sourceStart,
    gpuEncoder === "videotoolbox" ? gpuEncoder : null,
    spawnProcess,
    cancelGraceMs,
  );
  return true;
}
