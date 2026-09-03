import { EventEmitter } from "node:events";

import { parseAutomation, sampleAutomationLane } from "@hyperframes/core/audio-automation";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { buildCaptionModel } from "../../src/captions/parser";
import { applyNativeFrameToDocument } from "../../src/project/nativeFrameApplication";
import { evaluateNativeParameterTrack } from "../../src/project/nativeKeyframeEvaluator";
import { projectFrameFromSeconds } from "../../src/project/nativePropertyEditPlan";
import { createNativeParameterTrack, type RationalFrameRate } from "../../src/project/nativeKeyframeTypes";
import { projectFrameAtSeconds } from "../../src/player/lib/nativePlaybackAdapter";
import { forceRenderAdapterTime } from "../../src/player/lib/playbackSeek";
import type { PlaybackAdapter } from "../../src/player/lib/playbackTypes";
import { videoThumbnailTimestamps } from "../../src/player/lib/thumbnailVideoDecoder";
import { frameToSeconds, secondsToFrame } from "../../src/player/lib/time";
import { buildFrameCaptureFilename } from "../../src/utils/frameCapture";
import {
  EXPORT_FORMAT_CAPABILITIES,
  EXPORT_RESOLUTION_PRESETS,
  MAX_EXPORT_LONG_EDGE,
  MAX_EXPORT_SHORT_EDGE,
  estimateExportAudioSizeBytes,
  exportAspectRatioLabel,
  isValidExportOutputDimensions,
  resolveEncodedDimensions,
  resolveExportTargetDimensions,
  type ExportFormat,
  type ExportResolutionPreset,
} from "../../src/utils/exportPolicy";
import {
  classifyMediaImportPath,
  inspectMediaImportFile,
} from "../../src/utils/mediaImportPolicy";
import { splitAudioAutomation } from "../../src/utils/splitAudioAutomation";
import {
  buildTimelineFileDropPlacements,
  fitTimelineAssetGeometry,
} from "../../src/utils/timelineAssetDrop";
import { isSplitTimeWithinBounds, SPLIT_BOUNDARY_EPSILON_S } from "../../src/utils/timelineElementSplit";
import { buildStandaloneProducerRenderConfig } from "../../vite.export-adapter";
import {
  tryDirectMediaExport,
  type DirectMediaProbe,
} from "../../vite.direct-media-export";
import { createRenderCancellationRegistry } from "../../vite.render-cancellation";
import type {
  VideoQaBehaviorContract,
  VideoQaInvariantEntry,
} from "./videoQaContractTypes";
import { loadVideoQaCorpus } from "./videoQaCorpus";

const FRAME_RATES: readonly RationalFrameRate[] = [
  { numerator: 24, denominator: 1 },
  { numerator: 25, denominator: 1 },
  { numerator: 30_000, denominator: 1_001 },
  { numerator: 30, denominator: 1 },
  { numerator: 50, denominator: 1 },
  { numerator: 60_000, denominator: 1_001 },
  { numerator: 60, denominator: 1 },
];

const IMPORT_CASES = [
  { name: "clip.mp4", type: "video/mp4", kind: "video" },
  { name: "clip.MOV", type: "video/quicktime", kind: "video" },
  { name: "voice.wav", type: "audio/wav", kind: "audio" },
  { name: "voice.m4a", type: "audio/mp4", kind: "audio" },
  { name: "still.png", type: "image/png", kind: "image" },
] as const;

const PLATFORM_ONLY_EXTENSIONS = ["avasset", "gst", "py", "metal"] as const;

const pick = <T>(values: readonly T[], questionId: number): T =>
  values[Math.abs(questionId) % values.length]!;

function assertKeyframeContract(questionId: number): void {
  const endFrame = 12 + (questionId % 97);
  const sampleFrame = 1 + (questionId % (endFrame - 1));
  const startValue = (questionId % 23) - 11;
  const endValue = startValue + 90;
  const interpolation = questionId % 3 === 0
    ? { type: "hold" as const }
    : questionId % 3 === 1
      ? { type: "linear" as const }
      : {
          type: "cubic-bezier" as const,
          controlPoints: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
        };
  const track = createNativeParameterTrack({
    id: `qa-track-${questionId}`,
    parameterId: "transform.rotation",
    valueType: "number",
    frameRate: pick(FRAME_RATES, questionId),
    keyframes: [
      { id: "start", frame: 0, value: startValue, outgoing: interpolation },
      { id: "end", frame: endFrame, value: endValue, outgoing: { type: "hold" } },
    ],
  });
  const sampled = evaluateNativeParameterTrack(track, sampleFrame);
  if (interpolation.type === "hold") {
    expect(sampled).toBe(startValue);
  } else if (interpolation.type === "linear") {
    const expected = startValue + ((endValue - startValue) * sampleFrame) / endFrame;
    expect(sampled).toBeCloseTo(expected, 12);
  } else {
    expect(sampled).toBeGreaterThan(startValue);
    expect(sampled).toBeLessThan(endValue);
    expect(evaluateNativeParameterTrack(track, sampleFrame)).toBe(sampled);
  }
  expect(evaluateNativeParameterTrack(track, 0)).toBe(startValue);
  expect(evaluateNativeParameterTrack(track, endFrame)).toBe(endValue);
}

function assertTimebaseContract(questionId: number): void {
  const frameRate = pick(FRAME_RATES, questionId);
  const frame = 1 + (questionId % 10_000);
  const seconds = (frame * frameRate.denominator) / frameRate.numerator;

  expect(projectFrameFromSeconds(seconds, frameRate)).toBe(frame);
  expect(projectFrameAtSeconds(seconds, frameRate, frame + 2)).toBe(frame);

  const nominalFps = frameRate.numerator / frameRate.denominator;
  expect(secondsToFrame(frameToSeconds(frame, nominalFps), nominalFps)).toBe(frame);
}

function assertMediaImportContract(questionId: number): void {
  const media = pick(IMPORT_CASES, questionId);
  const result = inspectMediaImportFile({ name: media.name, type: media.type, size: 1_024 });

  expect(result).toMatchObject({ accepted: true, kind: media.kind });
  expect(classifyMediaImportPath(media.name)).toBe(media.kind);
}

function assertCodecContainerContract(questionId: number): void {
  const format = pick(Object.keys(EXPORT_FORMAT_CAPABILITIES) as ExportFormat[], questionId);
  const capability = EXPORT_FORMAT_CAPABILITIES[format];

  expect(capability.extension).toBe(`.${format}`);
  expect(capability.mimeType).toMatch(/^video\//u);
  expect(capability.video.codec.length).toBeGreaterThan(0);
  expect(capability.audio.codec.length).toBeGreaterThan(0);
  expect(capability.alpha.bitDepth > 0).toBe(capability.alpha.supported);
  expect(resolveEncodedDimensions("mp4", { width: 1_919, height: 1_079 })).toEqual({
    width: 1_920,
    height: 1_080,
  });
  expect(resolveEncodedDimensions("webm", { width: 1_919, height: 1_079 })).toBeNull();
  expect(resolveEncodedDimensions("mov", { width: 1_919, height: 1_079 })).toEqual({
    width: 1_919,
    height: 1_079,
  });
}

function assertExportContract(questionId: number): void {
  const presetName = pick(
    Object.keys(EXPORT_RESOLUTION_PRESETS) as ExportResolutionPreset[],
    questionId,
  );
  const preset = EXPORT_RESOLUTION_PRESETS[presetName];
  const dimensions = resolveExportTargetDimensions(presetName, null);

  expect(dimensions).toEqual({ width: preset.width, height: preset.height });
  expect(isValidExportOutputDimensions(dimensions)).toBe(true);
  expect(exportAspectRatioLabel(dimensions!)).toBe(preset.ratio);
  expect(resolveEncodedDimensions("mp4", dimensions!)).toEqual(dimensions);
}

function assertAudioSyncContract(questionId: number): void {
  const end = 8 + (questionId % 5);
  const splitAt = 1 + (questionId % (end - 1));
  const source = parseAutomation(JSON.stringify({
    version: 1,
    lanes: [{
      target: "volume",
      points: [
        { t: 0, v: 0.2 },
        { t: end, v: 0.9 },
      ],
    }],
  }));
  const { left, right } = splitAudioAutomation(source, splitAt);
  const sourceLane = source.lanes[0]!;
  const leftLane = left.lanes[0]!;
  const rightLane = right.lanes[0]!;

  expect(sampleAutomationLane(leftLane, splitAt)).toBeCloseTo(
    sampleAutomationLane(sourceLane, splitAt),
    12,
  );
  expect(sampleAutomationLane(rightLane, end - splitAt)).toBeCloseTo(
    sampleAutomationLane(sourceLane, end),
    12,
  );
}

function assertStreamingContract(questionId: number): void {
  const extension = questionId % 2 === 0 ? "m3u8" : "mpd";
  const result = inspectMediaImportFile({
    name: `remote-manifest.${extension}`,
    type: "application/octet-stream",
    size: 256,
  });

  expect(result).toEqual({ accepted: false, reason: "unsupported-extension" });
  expect(classifyMediaImportPath(`remote-manifest.${extension}`)).toBeNull();
}

function assertTimelineEditContract(questionId: number): void {
  const start = questionId % 13;
  const duration = 1 + (questionId % 20);
  const middle = start + duration / 2;

  expect(isSplitTimeWithinBounds(middle, start, duration)).toBe(true);
  expect(isSplitTimeWithinBounds(start, start, duration)).toBe(false);
  expect(isSplitTimeWithinBounds(start + duration, start, duration)).toBe(false);
  expect(isSplitTimeWithinBounds(start + SPLIT_BOUNDARY_EPSILON_S, start, duration)).toBe(true);
}

function assertTransformContract(questionId: number): void {
  const composition = questionId % 2 === 0
    ? { width: 1_920, height: 1_080 }
    : { width: 1_080, height: 1_920 };
  const natural = questionId % 3 === 0
    ? { width: 3_840, height: 2_160 }
    : { width: 2_160, height: 3_840 };
  const geometry = fitTimelineAssetGeometry(natural, composition);

  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.left + geometry.width).toBeLessThanOrEqual(composition.width);
  expect(geometry.top + geometry.height).toBeLessThanOrEqual(composition.height);
  expect(Math.abs(geometry.width / geometry.height - natural.width / natural.height)).toBeLessThan(0.002);
}

function assertGpuInterpolationContract(questionId: number): void {
  const endFrame = 20 + (questionId % 40);
  const sampleFrame = 1 + (questionId % (endFrame - 1));
  const track = createNativeParameterTrack({
    id: `qa-gpu-${questionId}`,
    parameterId: "transform.position",
    valueType: "vec2",
    frameRate: pick(FRAME_RATES, questionId),
    keyframes: [
      {
        id: "start",
        frame: 0,
        value: { x: -100, y: 50 },
        outgoing: {
          type: "cubic-bezier",
          controlPoints: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
        },
      },
      { id: "end", frame: endFrame, value: { x: 100, y: -50 }, outgoing: { type: "hold" } },
    ],
  });

  const first = evaluateNativeParameterTrack(track, sampleFrame);
  const repeated = evaluateNativeParameterTrack(track, sampleFrame);
  expect(repeated).toEqual(first);
  expect(first.x).toBeGreaterThanOrEqual(-100);
  expect(first.x).toBeLessThanOrEqual(100);
  expect(first.y).toBeGreaterThanOrEqual(-50);
  expect(first.y).toBeLessThanOrEqual(50);
}

function assertCaptionContract(questionId: number): void {
  const start = (questionId % 100) / 100;
  const model = buildCaptionModel(
    [
      { id: "word-a", text: "Frame", start, end: start + 0.4 },
      { id: "word-b", text: "accurate", start: start + 0.4, end: start + 0.9 },
    ],
    { width: 1_920, height: 1_080, duration: start + 1, wordsPerGroup: 2 },
  );

  expect(model.groupOrder).toEqual(["group-0"]);
  expect([...model.segments.values()].map(({ start: at, end }) => [at, end])).toEqual([
    [start, start + 0.4],
    [start + 0.4, start + 0.9],
  ]);
  expect([...model.segments.values()].every((segment) => segment.end <= model.duration)).toBe(true);
}

function assertPlatformAdapterContract(questionId: number): void {
  const extension = pick(PLATFORM_ONLY_EXTENSIONS, questionId);
  expect(classifyMediaImportPath(`native-object.${extension}`)).toBeNull();
  expect(inspectMediaImportFile({
    name: `native-object.${extension}`,
    type: "application/octet-stream",
    size: 32,
  })).toEqual({ accepted: false, reason: "unsupported-extension" });
  expect(inspectMediaImportFile({
    name: "portable-interchange.mov",
    type: "video/quicktime",
    size: 32,
  })).toMatchObject({ accepted: true, kind: "video", extension: "mov" });
}

function assertResourceCancellationContract(questionId: number): void {
  const registry = createRenderCancellationRegistry({ sweepIntervalMs: 0 });
  const lifecycle = registry.register(`qa-render-${questionId}`);
  try {
    expect(registry.activeCount()).toBe(1);
    expect(registry.cancel(`qa-render-${questionId}`)).toBe(true);
    expect(lifecycle.signal.aborted).toBe(true);
    expect(registry.cancel(`qa-render-${questionId}`)).toBe(false);
    expect(registry.activeCount()).toBe(0);
  } finally {
    registry.dispose();
  }
}

export async function auditAudioVideoSyncContract(questionId: number): Promise<{
  exported: boolean;
  args: string[];
}> {
  const fps = pick([24, 30, 60] as const, questionId);
  const duration = 5;
  const outputPath = "/project/out.mp4";
  const video = `<video id="clip" data-hf-id="clip" class="clip" src="assets/clip.mov" data-start="0" data-duration="${duration}" data-track-index="0" playsinline style="position: absolute; left: 0px; top: 0px; width: 1920px; height: 1080px; object-fit: contain; z-index: 1"></video>`;
  const html = `<!doctype html><html><head><style>html, body { width: 1920px; height: 1080px; margin: 0; overflow: hidden; background: black; } #root { position: relative; width: 1920px; height: 1080px; overflow: hidden; }</style><script src="vendor/gsap.min.js"></script></head><body><div id="root" data-hf-id="hf-root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="1920" data-height="1080">${video}</div><script>window.__timelines = window.__timelines || {}; window.__timelines["main"] = gsap.timeline({ paused: true });</script></body></html>`;
  const probe: DirectMediaProbe = {
    duration,
    streams: [
      { codecType: "video", codecName: "h264", width: 1920, height: 1080, frameRate: fps },
      { codecType: "audio", codecName: "aac" },
    ],
  };
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const spawnProcess = vi.fn((_command: string, _args: readonly string[]) => {
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  });

  const exported = await tryDirectMediaExport(
    {
      html,
      projectDir: "/project",
      outputPath,
      format: "mp4",
      fps,
      quality: "standard",
      dimensions: { width: 1920, height: 1080 },
    },
    {
      findBinary: (name) => `/opt/${name}`,
      detectGpuEncoder: async () => null,
      probeMedia: async () => probe,
      spawnProcess: spawnProcess as never,
      resolveRealPath: async (path) => path,
      statPath: (async () => ({ isFile: () => true })) as never,
    },
  );
  expect(spawnProcess).toHaveBeenCalledTimes(1);
  const args = [...(spawnProcess.mock.calls[0]?.[1] ?? [])];
  expect(args).toEqual(expect.arrayContaining([
    "-t", String(duration),
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-r", String(fps),
    "-fps_mode", "cfr",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
  ]));
  expect(args.at(-1)).toBe(outputPath);
  return { exported, args };
}

async function assertAudioVideoSyncContract(questionId: number): Promise<void> {
  const audit = await auditAudioVideoSyncContract(questionId);
  expect(audit.exported).toBe(true);
}

export function auditCompositingPixelContract(questionId: number): {
  firstStyle: string;
  repeatedStyle: string;
  visibleClipIds: string[];
  hiddenClipIds: string[];
} {
  const window = new Window();
  const document = window.document as unknown as Document;
  for (const clipId of ["foreground", "background"]) {
    const element = document.createElement("div");
    element.setAttribute("data-studio-clip-id", clipId);
    document.body.appendChild(element);
  }
  const opacity = 0.2 + (questionId % 5) / 10;
  const clips = [
    {
      clipId: "foreground",
      startFrame: 5,
      durationFrames: 20,
      staticParameters: { "visual.opacity": opacity },
      parameterTracks: [],
    },
    {
      clipId: "background",
      startFrame: 30,
      durationFrames: 20,
      staticParameters: { "visual.opacity": 0.9 },
      parameterTracks: [],
    },
  ] as const;
  const projectFrame = 10;

  expect(applyNativeFrameToDocument(document, clips, projectFrame)).toEqual({
    appliedClipIds: ["foreground", "background"],
    missingClipIds: [],
  });
  const foreground = document.querySelector<HTMLElement>('[data-studio-clip-id="foreground"]')!;
  const background = document.querySelector<HTMLElement>('[data-studio-clip-id="background"]')!;
  const firstStyle = foreground.getAttribute("style") ?? "";
  applyNativeFrameToDocument(document, clips, projectFrame);
  const repeatedStyle = foreground.getAttribute("style") ?? "";

  expect(foreground.style.visibility).toBe("visible");
  expect(Number(foreground.style.opacity)).toBeCloseTo(opacity, 12);
  expect(background.style.visibility).toBe("hidden");
  expect(repeatedStyle).toBe(firstStyle);

  return {
    firstStyle,
    repeatedStyle,
    visibleClipIds: [foreground, background]
      .filter((element) => element.style.visibility === "visible")
      .map((element) => element.getAttribute("data-studio-clip-id")!),
    hiddenClipIds: [foreground, background]
      .filter((element) => element.style.visibility === "hidden")
      .map((element) => element.getAttribute("data-studio-clip-id")!),
  };
}

function assertCompositingPixelContract(questionId: number): void {
  auditCompositingPixelContract(questionId);
}

function assertDecoderProbeFailureContract(questionId: number): void {
  const videoName = questionId % 2 === 0 ? "capture.mp4" : "capture.mov";
  expect(inspectMediaImportFile({ name: videoName, type: "image/png", size: 1_024 })).toEqual({
    accepted: false,
    reason: "mime-type-mismatch",
  });
  expect(inspectMediaImportFile({ name: videoName, type: "video/mp4", size: 0 })).toEqual({
    accepted: false,
    reason: "empty-file",
  });
}

function assertExportAlphaColorContract(): void {
  expect(EXPORT_FORMAT_CAPABILITIES.mp4).toMatchObject({
    alpha: { supported: false, bitDepth: 0 },
    color: { sdr: { primaries: "bt709", transfer: "bt709", matrix: "bt709" } },
  });
  expect(EXPORT_FORMAT_CAPABILITIES.webm.alpha).toEqual({ supported: true, bitDepth: 8 });
  expect(EXPORT_FORMAT_CAPABILITIES.mov.alpha).toEqual({ supported: true, bitDepth: 10 });
  expect(EXPORT_FORMAT_CAPABILITIES.mov.video.pixelFormat).toContain("a");
}

function assertExportBitrateContract(questionId: number): void {
  const format = pick(Object.keys(EXPORT_FORMAT_CAPABILITIES) as ExportFormat[], questionId);
  const duration = 1 + (questionId % 600);
  const bitrateKbps = EXPORT_FORMAT_CAPABILITIES[format].audio.bitrateKbps;

  expect(estimateExportAudioSizeBytes(duration, format, true)).toBe(
    Math.round((duration * bitrateKbps * 1_000) / 8),
  );
  expect(estimateExportAudioSizeBytes(duration + 1, format, true)).toBeGreaterThan(
    estimateExportAudioSizeBytes(duration, format, true),
  );
  expect(estimateExportAudioSizeBytes(duration, format, false)).toBe(0);
}

function assertExportCodecPolicyContract(): void {
  expect(EXPORT_FORMAT_CAPABILITIES.mp4.video).toMatchObject({
    codec: "h264",
    encoder: "libx264",
    pixelFormat: "yuv420p",
  });
  expect(EXPORT_FORMAT_CAPABILITIES.webm.video).toMatchObject({
    codec: "vp9",
    encoder: "libvpx-vp9",
    pixelFormat: "yuva420p",
  });
  expect(EXPORT_FORMAT_CAPABILITIES.mov.video).toMatchObject({
    codec: "prores",
    encoder: "prores_ks",
    profile: "4444",
  });
}

function assertExportResolutionContract(questionId: number): void {
  assertExportContract(questionId);
  expect(isValidExportOutputDimensions({
    width: MAX_EXPORT_LONG_EDGE,
    height: MAX_EXPORT_SHORT_EDGE,
  })).toBe(true);
  expect(isValidExportOutputDimensions({
    width: MAX_EXPORT_LONG_EDGE + 2,
    height: MAX_EXPORT_SHORT_EDGE,
  })).toBe(false);
  expect(isValidExportOutputDimensions({ width: 1_921, height: 1_080 })).toBe(false);
}

function assertHardwareAccelerationContract(): void {
  const base = { fps: { num: 30, den: 1 } as const, quality: "standard" as const };
  expect(buildStandaloneProducerRenderConfig({ ...base, format: "mp4" })).toHaveProperty(
    "useGpu",
    true,
  );
  expect(buildStandaloneProducerRenderConfig({ ...base, format: "webm" })).not.toHaveProperty(
    "useGpu",
  );
  expect(buildStandaloneProducerRenderConfig({ ...base, format: "mov" })).not.toHaveProperty(
    "useGpu",
  );
}

function assertPlaybackPauseReseekContract(): void {
  assertForcedSeekContract();
}

function assertResourceWorkerBudgetContract(questionId: number): void {
  const untrusted = {
    fps: { num: 30, den: 1 },
    quality: "standard",
    format: "mp4",
    workers: 1 + (questionId % 128),
    producerConfig: { concurrency: 1 + (questionId % 128) },
  } as unknown as Parameters<typeof buildStandaloneProducerRenderConfig>[0];
  const config = buildStandaloneProducerRenderConfig(untrusted);

  expect(config).not.toHaveProperty("workers");
  expect(config).not.toHaveProperty("producerConfig");
}

function assertStreamTimestampContract(questionId: number): void {
  const frameRate = pick(FRAME_RATES, questionId);
  const durationFrames = 240;
  let previous = -1;
  for (let frame = 0; frame < durationFrames; frame += 17) {
    const seconds = (frame * frameRate.denominator) / frameRate.numerator;
    const mapped = projectFrameAtSeconds(seconds, frameRate, durationFrames);
    expect(mapped).toBe(frame);
    expect(mapped).toBeGreaterThan(previous);
    previous = mapped;
  }
}

function assertThumbnailExtractionContract(questionId: number): void {
  const time = (questionId % 10_000) / 1_000;
  const filename = buildFrameCaptureFilename("compositions/preview.html", time);
  const timestamps = videoThumbnailTimestamps(time, 6, 4);
  expect(filename).toMatch(/^preview-\d+-\d{3}s\.png$/u);
  expect(buildFrameCaptureFilename("compositions/preview.html", time)).toBe(filename);
  expect(buildFrameCaptureFilename(null, time)).not.toBe(filename);
  expect(timestamps).toEqual([time, time + 2, time + 4, time + 6]);
  expect([...timestamps].sort((left, right) => left - right)).toEqual(timestamps);
}

function assertTimelineIntegrityContract(questionId: number): void {
  const track = questionId % 12;
  const start = (questionId % 100) / 10;
  const placements = buildTimelineFileDropPlacements(
    { start, track },
    [1.25, 2.5, 0.75],
  );

  expect(placements).toEqual([
    { start, track },
    { start: Number((start + 1.25).toFixed(2)), track },
    { start: Number((start + 3.75).toFixed(2)), track },
  ]);
  expect(placements.every((placement) => placement.track === track)).toBe(true);
}

const ASSERTIONS: Readonly<
  Record<VideoQaBehaviorContract, (questionId: number) => void | Promise<void>>
> = {
  "animation-keyframe-interpolation": assertKeyframeContract,
  "audio-automation-split": assertAudioSyncContract,
  "audio-video-sync": assertAudioVideoSyncContract,
  "caption-timing": assertCaptionContract,
  "codec-container-compatibility": assertCodecContainerContract,
  "compositing-pixel-stability": assertCompositingPixelContract,
  "decoder-probe-failure": assertDecoderProbeFailureContract,
  "export-alpha-color": assertExportAlphaColorContract,
  "export-bitrate-size": assertExportBitrateContract,
  "export-codec-policy": assertExportCodecPolicyContract,
  "export-resolution-limit": assertExportResolutionContract,
  "frame-rate-timebase": assertTimebaseContract,
  "hardware-acceleration-policy": assertHardwareAccelerationContract,
  "media-import-classification": assertMediaImportContract,
  "platform-capability-boundary": assertPlatformAdapterContract,
  "playback-pause-reseek": assertPlaybackPauseReseekContract,
  "render-cancellation-cleanup": assertResourceCancellationContract,
  "resource-worker-budget": assertResourceWorkerBudgetContract,
  "stream-manifest-rejection": assertStreamingContract,
  "stream-timestamp-continuity": assertStreamTimestampContract,
  "thumbnail-frame-extraction": assertThumbnailExtractionContract,
  "timeline-edit-integrity": assertTimelineIntegrityContract,
  "transform-canvas-geometry": assertTransformContract,
  "trim-split-boundary": assertTimelineEditContract,
};

export async function assertVideoQaBehaviorContract(
  contract: VideoQaBehaviorContract,
  questionId: number,
): Promise<void> {
  await ASSERTIONS[contract](questionId);
}

/** Register one cheap behavioral test per source row while sharing family-level fixtures. */
export function registerVideoQaContractTests(
  label: string,
  entries: readonly VideoQaInvariantEntry[],
): void {
  const corpus = loadVideoQaCorpus();
  describe(label, () => {
    for (const entry of entries) {
      const source = corpus[entry.sourceLine - 1];
      const title = source?.title.replace(/\s+/gu, " ").trim().slice(0, 100) ?? "missing source";
      it(`[${entry.questionId}] ${title}`, async () => {
        expect(source?.question_id).toBe(entry.questionId);
        await assertVideoQaBehaviorContract(entry.contract, entry.questionId);
      });
    }
  });
}

/** A smoke helper proving same-position repaint uses a distinct frame guard. */
export function assertForcedSeekContract(): void {
  const seeks: number[] = [];
  const adapter: PlaybackAdapter = {
    play() {},
    pause() {},
    seek(time) { seeks.push(time); },
    getTime: () => 3,
    getDuration: () => 10,
    isPlaying: () => false,
  };
  forceRenderAdapterTime(adapter, 3);
  expect(seeks).toHaveLength(2);
  expect(seeks[1]).toBe(3);
  expect(Math.abs(seeks[0]! - 3)).toBeGreaterThan(1 / 24);
}
