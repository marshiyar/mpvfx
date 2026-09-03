/**
 * Shared media decoding for speech-aware editor features.
 *
 * Carve and levelling must hear the same signal and obey the same lifecycle.
 * Keeping fetch, decode, stereo downmixing and abort checks here prevents the
 * two features from quietly disagreeing about whether a voice track is usable.
 */

export const VOICE_DECODE_SAMPLE_RATE = 48_000;

export interface DecodedVoiceAudio {
  samples: Float32Array;
  sampleRate: number;
}

interface DecodeVoiceAudioOptions {
  document: Document;
  source: string;
  signal?: AbortSignal;
  sampleRate?: number;
}

/** Throw a stable AbortError even in runtimes without AbortSignal.throwIfAborted. */
export function throwIfVoiceProcessingAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Voice processing was aborted", "AbortError");
}

/** True only for cancellation; ordinary media failures can be skipped independently. */
export function isVoiceProcessingAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

/**
 * Fold every decoded channel into mono for analysis.
 *
 * Returning the original mono channel avoids copying long narration files. A
 * multi-channel source is averaged, so speech present only on the right (or a
 * later surround channel) remains audible without increasing peak amplitude.
 */
export function downmixVoiceAudioBuffer(buffer: AudioBuffer): Float32Array {
  const declaredChannels = Number(buffer.numberOfChannels);
  const channelCount = Number.isFinite(declaredChannels) && declaredChannels > 0 ? declaredChannels : 1;
  const first = buffer.getChannelData(0);
  if (channelCount === 1) return first;

  const mixed = new Float32Array(first.length);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = buffer.getChannelData(channelIndex);
    const length = Math.min(mixed.length, channel.length);
    for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
      mixed[sampleIndex] += channel[sampleIndex]! / channelCount;
    }
  }
  return mixed;
}

/** Fetch and decode a project-relative audio source without touching an output device. */
export async function decodeVoiceAudioSource({
  document,
  source,
  signal,
  sampleRate = VOICE_DECODE_SAMPLE_RATE,
}: DecodeVoiceAudioOptions): Promise<DecodedVoiceAudio | null> {
  const Ctor =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!Ctor) return null;

  throwIfVoiceProcessingAborted(signal);
  const response = await fetch(new URL(source, document.baseURI).href, { signal });
  throwIfVoiceProcessingAborted(signal);
  if (response.ok === false) {
    throw new Error(
      `Voice media request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})`,
    );
  }

  const bytes = await response.arrayBuffer();
  throwIfVoiceProcessingAborted(signal);
  const buffer = await new Ctor(1, 1, sampleRate).decodeAudioData(bytes);
  throwIfVoiceProcessingAborted(signal);
  if (!Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0) {
    throw new Error("Voice media decoded with an invalid sample rate");
  }
  // Carve mixes every source on one clock. OfflineAudioContext is required to
  // resample decoded media to its own rate; accepting a different rate here
  // would make offsets, FFT windows and envelopes drift while still appearing
  // numerically valid downstream.
  if (buffer.sampleRate !== sampleRate) {
    throw new Error(
      `Voice media decoded at an unexpected sample rate (${buffer.sampleRate}; expected ${sampleRate})`,
    );
  }
  return { samples: downmixVoiceAudioBuffer(buffer), sampleRate: buffer.sampleRate };
}
