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

const ANALYSIS_WINDOW_SECONDS = 0.01;

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
