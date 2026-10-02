export interface AudioActivityRange {
  start: number;
  end: number;
}

export interface AudioActivityAnalysis {
  duration: number;
  activeRanges: AudioActivityRange[];
}

export interface SpeechSegment {
  sourceStart: number;
  sourceEnd: number;
}

export interface SilenceDetectionOptions {
  minimumPauseSeconds?: number;
  paddingSeconds?: number;
}

export const DEFAULT_SILENCE_DETECTION_OPTIONS = {
  minimumPauseSeconds: 0.8,
  paddingSeconds: 0.18,
} as const;

interface VadSpeechRange {
  start: number;
  end: number;
}

interface SpeechVadInstance {
  frameProcessor: { reset?: () => void; resume: () => void };
  run: (inputAudio: Float32Array, sampleRate: number) => AsyncGenerator<{
    start: number;
    end: number;
  }>;
}

type SpeechVadFactory = () => Promise<SpeechVadInstance>;

async function createSpeechVad(): Promise<SpeechVadInstance> {
  const { NonRealTimeVAD } = await import("@ricky0123/vad-web");
  const baseAssetUrl = new URL("/vad/", window.location.origin).href;
  return NonRealTimeVAD.new({
    modelURL: `${baseAssetUrl}silero_vad_legacy.onnx`,
    modelFetcher: async (path) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Could not load local speech model (${response.status})`);
      return response.arrayBuffer();
    },
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    redemptionMs: 300,
    preSpeechPadMs: 0,
    minSpeechMs: 180,
    submitUserSpeechOnPause: false,
    ortConfig: (ort) => {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = {
        mjs: `${baseAssetUrl}ort-wasm-simd-threaded.mjs`,
        wasm: `${baseAssetUrl}ort-wasm-simd-threaded.wasm`,
      };
    },
  });
}

let speechVadPromise: Promise<SpeechVadInstance> | null = null;

function getSpeechVad(): Promise<SpeechVadInstance> {
  if (!speechVadPromise) {
    speechVadPromise = createSpeechVad().catch((error: unknown) => {
      speechVadPromise = null;
      throw error;
    });
  }
  return speechVadPromise;
}

function mergeSpeechRanges(ranges: VadSpeechRange[], duration: number): AudioActivityRange[] {
  const ordered = ranges
    .map(({ start, end }) => ({
      start: Math.max(0, Math.min(duration, start)),
      end: Math.max(0, Math.min(duration, end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const merged: AudioActivityRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Decode a selected audio/video file locally and ask Silero VAD for speech ranges. */
export async function analyzeSpeechWithVAD(
  file: File,
  createVad: SpeechVadFactory = getSpeechVad,
): Promise<AudioActivityAnalysis> {
  const ctx = new AudioContext();
  try {
    const audioBuffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) =>
      audioBuffer.getChannelData(index),
    );
    if (channels.length === 0) {
      return { duration: audioBuffer.duration, activeRanges: [] };
    }

    const vad = await createVad();
    const speechRanges: VadSpeechRange[] = [];
    for (const channel of channels) {
      vad.frameProcessor.reset?.();
      for await (const range of vad.run(channel, audioBuffer.sampleRate)) {
        speechRanges.push({ start: range.start / 1000, end: range.end / 1000 });
      }
    }

    return {
      duration: audioBuffer.duration,
      activeRanges: mergeSpeechRanges(speechRanges, audioBuffer.duration),
    };
  } finally {
    void ctx.close();
  }
}

/** Group quiet gaps into cuts while preserving configurable room around speech. */
export function buildSpeechSegments(
  analysis: AudioActivityAnalysis,
  opts: Pick<SilenceDetectionOptions, "minimumPauseSeconds" | "paddingSeconds"> = {},
): SpeechSegment[] {
  const duration = Math.max(0, analysis.duration);
  if (duration === 0 || analysis.activeRanges.length === 0) {
    return [{ sourceStart: 0, sourceEnd: duration }];
  }

  const minimumPauseSeconds = Math.max(
    0,
    opts.minimumPauseSeconds ?? DEFAULT_SILENCE_DETECTION_OPTIONS.minimumPauseSeconds,
  );
  const paddingSeconds = Math.max(
    0,
    opts.paddingSeconds ?? DEFAULT_SILENCE_DETECTION_OPTIONS.paddingSeconds,
  );
  const ranges = analysis.activeRanges
    .map(({ start, end }) => ({
      start: Math.max(0, Math.min(duration, start)),
      end: Math.max(0, Math.min(duration, end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  if (ranges.length === 0) return [{ sourceStart: 0, sourceEnd: duration }];

  const segments: SpeechSegment[] = [];
  let currentStart = ranges[0]!.start;
  let currentEnd = ranges[0]!.end;
  const appendSegment = (start: number, end: number) => {
    const sourceStart = Math.max(0, start - paddingSeconds);
    const sourceEnd = Math.min(duration, end + paddingSeconds);
    if (sourceEnd > sourceStart) segments.push({ sourceStart, sourceEnd });
  };

  for (const range of ranges.slice(1)) {
    const gap = range.start - currentEnd;
    if (gap >= minimumPauseSeconds && gap > paddingSeconds * 2) {
      appendSegment(currentStart, currentEnd);
      currentStart = range.start;
      currentEnd = range.end;
    } else {
      currentEnd = Math.max(currentEnd, range.end);
    }
  }
  appendSegment(currentStart, currentEnd);
  return segments;
}

export interface SilenceCutReviewMedia {
  readonly file: File;
  readonly kind: "audio" | "video";
  readonly analysis: AudioActivityAnalysis;
}

export interface SilenceCutReviewDecision {
  readonly minimumPauseSeconds: number;
  readonly paddingSeconds: number;
}