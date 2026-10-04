import type { NativePlaybackRate } from "./nativeProjectDocument";

export interface NativeSourcePosition {
  sourceInFrame: number;
  /** Exact part of a source frame, normalized to [0, 1). */
  sourceInFraction?: NativePlaybackRate;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function safe(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Media time exceeds the supported range");
  return Number(value);
}

export function rationalFromNumber(value: number): NativePlaybackRate {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("Media time must be finite and nonnegative");
  // Reconstruct a rational once at the floating-point UI boundary. In
  // particular, 1/30 seconds must not become a 10^17-denominator decimal.
  let previousN = 0, numerator = 1, previousD = 1, denominator = 0;
  let rest = value;
  for (let iteration = 0; iteration < 48; iteration++) {
    const whole = Math.floor(rest);
    const nextN = whole * numerator + previousN;
    const nextD = whole * denominator + previousD;
    if (!Number.isSafeInteger(nextN) || !Number.isSafeInteger(nextD) || nextD > 1_000_000_000) break;
    [previousN, numerator] = [numerator, nextN];
    [previousD, denominator] = [denominator, nextD];
    const remainder = rest - whole;
    if (remainder === 0 || Math.abs(numerator / denominator - value) <= 4 * Number.EPSILON * Math.max(1, value)) break;
    rest = 1 / remainder;
  }
  if (denominator === 0) throw new RangeError("Media time exceeds the supported range");
  return { numerator, denominator };
}

function position(numerator: bigint, denominator: bigint): NativeSourcePosition {
  if (numerator < 0n) throw new RangeError("Cannot extend before the beginning of the source media");
  const whole = numerator / denominator;
  const remainder = numerator % denominator;
  const divisor = gcd(remainder, denominator);
  return {
    sourceInFrame: safe(whole),
    sourceInFraction: remainder === 0n ? undefined : {
      numerator: safe(remainder / divisor), denominator: safe(denominator / divisor),
    },
  };
}

export function sourcePositionFromSeconds(seconds: number, frameRate: NativePlaybackRate): NativeSourcePosition {
  const time = rationalFromNumber(seconds);
  return position(BigInt(time.numerator) * BigInt(frameRate.numerator), BigInt(time.denominator) * BigInt(frameRate.denominator));
}

export function advanceSourcePosition(
  clip: NativeSourcePosition & { playbackRate?: NativePlaybackRate }, timelineFrames: number,
): NativeSourcePosition {
  const fraction = clip.sourceInFraction ?? { numerator: 0, denominator: 1 };
  const rate = clip.playbackRate ?? { numerator: 1, denominator: 1 };
  const denominator = BigInt(fraction.denominator) * BigInt(rate.denominator);
  const numerator = (BigInt(clip.sourceInFrame) * BigInt(fraction.denominator) + BigInt(fraction.numerator)) * BigInt(rate.denominator)
    + BigInt(timelineFrames) * BigInt(rate.numerator) * BigInt(fraction.denominator);
  return position(numerator, denominator);
}

export function sourceFrameValue(clip: NativeSourcePosition): number {
  return clip.sourceInFrame + (clip.sourceInFraction ? clip.sourceInFraction.numerator / clip.sourceInFraction.denominator : 0);
}

export function availableTimelineFrames(
  clip: NativeSourcePosition & { playbackRate?: NativePlaybackRate }, sourceDurationFrames: number,
): number {
  const fraction = clip.sourceInFraction ?? { numerator: 0, denominator: 1 };
  const rate = clip.playbackRate ?? { numerator: 1, denominator: 1 };
  const remaining = BigInt(sourceDurationFrames - clip.sourceInFrame) * BigInt(fraction.denominator) - BigInt(fraction.numerator);
  if (remaining < 0n) return 0;
  const frames = remaining * BigInt(rate.denominator) / (BigInt(fraction.denominator) * BigInt(rate.numerator));
  return Number(frames > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : frames);
}

export function sourceRangeFits(
  clip: NativeSourcePosition & { playbackRate?: NativePlaybackRate }, durationFrames: number, sourceDurationFrames: number,
): boolean {
  const fraction = clip.sourceInFraction ?? { numerator: 0, denominator: 1 };
  const rate = clip.playbackRate ?? { numerator: 1, denominator: 1 };
  const denominator = BigInt(fraction.denominator) * BigInt(rate.denominator);
  const end = (BigInt(clip.sourceInFrame) * BigInt(fraction.denominator) + BigInt(fraction.numerator)) * BigInt(rate.denominator)
    + BigInt(durationFrames) * BigInt(rate.numerator) * BigInt(fraction.denominator);
  return end <= BigInt(sourceDurationFrames) * denominator;
}
