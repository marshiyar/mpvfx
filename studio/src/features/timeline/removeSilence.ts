import type { TimelineElement } from "../../player/index";

export interface SilenceRange {
  start: number;
  end: number;
}

export interface SilenceRemovalOptions {
  thresholdDb: number;
  minimumSilenceSeconds: number;
  paddingSeconds: number;
}

export const DEFAULT_SILENCE_REMOVAL_OPTIONS: SilenceRemovalOptions = {
  thresholdDb: -42,
  minimumSilenceSeconds: 0.65,
  paddingSeconds: 0.12,
};

export interface SilenceRemovalSegment extends SilenceRange {
  remove: boolean;
}

export interface SilenceRemovalPlan {
  cutTimes: number[];
  removedRanges: SilenceRange[];
  segments: SilenceRemovalSegment[];
  removedSeconds: number;
}

const ANALYSIS_WINDOW_SECONDS = 0.01;
const RANGE_EPSILON_SECONDS = 1e-6;

/** Return padded source-time intervals whose windowed RMS is below the threshold. */
export function detectSilences(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: Partial<SilenceRemovalOptions> = {},
): SilenceRange[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || channels.length === 0) return [];
  const sampleCount = Math.max(...channels.map((channel) => channel.length));
  if (sampleCount === 0) return [];

  const thresholdDb = options.thresholdDb ?? DEFAULT_SILENCE_REMOVAL_OPTIONS.thresholdDb;
  const minimumSilenceSeconds = Math.max(
    0,
    options.minimumSilenceSeconds ??
      DEFAULT_SILENCE_REMOVAL_OPTIONS.minimumSilenceSeconds,
  );
  const paddingSeconds = Math.max(
    0,
    options.paddingSeconds ?? DEFAULT_SILENCE_REMOVAL_OPTIONS.paddingSeconds,
  );
  const thresholdAmplitude = 10 ** (thresholdDb / 20);
  const windowFrames = Math.max(1, Math.round(sampleRate * ANALYSIS_WINDOW_SECONDS));
  const silences: SilenceRange[] = [];
  let silenceStartFrame: number | null = null;

  const finishSilence = (endFrame: number) => {
    if (silenceStartFrame === null) return;
    const start = silenceStartFrame / sampleRate;
    const end = endFrame / sampleRate;
    silenceStartFrame = null;
    if (end - start < minimumSilenceSeconds) return;
    const paddedStart = start + paddingSeconds;
    const paddedEnd = end - paddingSeconds;
    if (paddedEnd > paddedStart) silences.push({ start: paddedStart, end: paddedEnd });
  };

  for (let windowStart = 0; windowStart < sampleCount; windowStart += windowFrames) {
    const windowEnd = Math.min(sampleCount, windowStart + windowFrames);
    let sumSquares = 0;
    let sampleTotal = 0;
    for (const channel of channels) {
      for (let frame = windowStart; frame < Math.min(windowEnd, channel.length); frame++) {
        const sample = channel[frame]!;
        if (!Number.isFinite(sample)) continue;
        sumSquares += sample * sample;
        sampleTotal++;
      }
    }
    const rms = sampleTotal > 0 ? Math.sqrt(sumSquares / sampleTotal) : 0;
    if (rms <= thresholdAmplitude) {
      silenceStartFrame ??= windowStart;
    } else {
      finishSilence(windowStart);
    }
  }
  finishSilence(sampleCount);
  return silences;
}

/** Map source-time silence intervals onto a clip and divide it into keep/remove pieces. */
export function planSilenceRemoval(
  element: Pick<
    TimelineElement,
    "start" | "duration" | "playbackStart" | "playbackRate"
  >,
  sourceSilences: readonly SilenceRange[],
): SilenceRemovalPlan {
  const clipStart = element.start;
  const clipDuration = Math.max(0, element.duration);
  const clipEnd = clipStart + clipDuration;
  const sourceStart = Math.max(0, element.playbackStart ?? 0);
  const playbackRate =
    element.playbackRate != null && Number.isFinite(element.playbackRate) && element.playbackRate > 0
      ? element.playbackRate
      : 1;
  const sourceEnd = sourceStart + clipDuration * playbackRate;
  const orderedSourceRanges = sourceSilences
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end))
    .map((range) => ({ start: Math.max(sourceStart, range.start), end: Math.min(sourceEnd, range.end) }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);

  const removedRanges: SilenceRange[] = [];
  for (const range of orderedSourceRanges) {
    const mapped = {
      start: clipStart + (range.start - sourceStart) / playbackRate,
      end: clipStart + (range.end - sourceStart) / playbackRate,
    };
    const previous = removedRanges.at(-1);
    if (previous && mapped.start <= previous.end + RANGE_EPSILON_SECONDS) {
      previous.end = Math.max(previous.end, mapped.end);
    } else {
      removedRanges.push(mapped);
    }
  }

  const segments: SilenceRemovalSegment[] = [];
  const cutTimes = new Set<number>();
  let cursor = clipStart;
  for (const range of removedRanges) {
    if (range.start > cursor + RANGE_EPSILON_SECONDS) {
      segments.push({ start: cursor, end: range.start, remove: false });
      if (range.start < clipEnd - RANGE_EPSILON_SECONDS) cutTimes.add(range.start);
    }
    segments.push({ ...range, remove: true });
    if (range.start > clipStart + RANGE_EPSILON_SECONDS) cutTimes.add(range.start);
    if (range.end < clipEnd - RANGE_EPSILON_SECONDS) cutTimes.add(range.end);
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < clipEnd - RANGE_EPSILON_SECONDS) {
    segments.push({ start: cursor, end: clipEnd, remove: false });
  }

  return {
    cutTimes: [...cutTimes].sort((left, right) => left - right),
    removedRanges,
    segments,
    removedSeconds: removedRanges.reduce((sum, range) => sum + range.end - range.start, 0),
  };
}