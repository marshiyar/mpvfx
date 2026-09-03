import { applyNativeFrameToDocument, type NativeClipFrameBinding } from "../../project/nativeFrameApplication";
import { validateRationalFrameRate, type RationalFrameRate } from "../../project/nativeKeyframeTypes";
import { createStaticSeekPlaybackAdapter, getAdapterDuration } from "./playbackAdapter";
import type {
  PlaybackAdapter,
  RuntimePlaybackAdapter,
  StaticSeekPlaybackClock,
} from "./playbackTypes";

export type NativePlaybackAssetKind = "video" | "audio" | "image";

export interface NativePlaybackClipBinding extends NativeClipFrameBinding {
  /** Durable media identity projected from the native project document. */
  readonly assetId?: string;
  readonly assetKind?: NativePlaybackAssetKind;
  /** Source-media frame at the clip's first timeline frame. */
  readonly sourceInFrame?: number;
  /** Exact authored source speed. Number remains accepted for transitional callers. */
  readonly playbackRate?: number | RationalFrameRate;
  readonly muted?: boolean;
}

export interface NativePlaybackAdapterOptions {
  readonly document: Document;
  readonly frameRate: RationalFrameRate;
  readonly durationFrames: number;
  readonly clips: readonly NativePlaybackClipBinding[];
  readonly clock: StaticSeekPlaybackClock;
  readonly getPlaybackRate?: () => number;
  /** Existing composition/media transport retained for video and audio playback. */
  readonly baseAdapter?: PlaybackAdapter | RuntimePlaybackAdapter | null;
}

export interface NativePlaybackWindowLike {
  readonly __studioNativePlayer?: RuntimePlaybackAdapter | PlaybackAdapter;
  readonly __player?: RuntimePlaybackAdapter | PlaybackAdapter;
}

/** Runtime wrapper with an ownership-only teardown separate from user pause. */
export interface NativePlaybackAdapter extends RuntimePlaybackAdapter {
  /** Stop only the native animation clock; never pause the shared base media. */
  dispose(): void;
}

function validateDurationFrames(durationFrames: number): number {
  if (!Number.isInteger(durationFrames) || durationFrames <= 0) {
    throw new TypeError("Native playback durationFrames must be a positive integer");
  }
  return durationFrames;
}

function findNativeClipRoot(document: Document, clipId: string): HTMLElement | null {
  for (const candidate of document.querySelectorAll(`[data-studio-clip-id]`)) {
    if (candidate.getAttribute("data-studio-clip-id") === clipId) return candidate as HTMLElement;
  }
  return null;
}

function findNativeClipMedia(
  document: Document,
  clip: NativePlaybackClipBinding,
): HTMLMediaElement | null {
  if (clip.assetKind !== "video" && clip.assetKind !== "audio") return null;
  const root = findNativeClipRoot(document, clip.clipId);
  if (!root) return null;
  const expectedTag = clip.assetKind;
  if (root.tagName.toLowerCase() === expectedTag) return root as unknown as HTMLMediaElement;
  return root.querySelector<HTMLMediaElement>(expectedTag);
}

function resolveClipPlaybackRate(rate: NativePlaybackClipBinding["playbackRate"]): number {
  if (typeof rate === "number") return Number.isFinite(rate) && rate > 0 ? rate : 1;
  if (rate && Number.isInteger(rate.numerator) && Number.isInteger(rate.denominator) &&
      rate.numerator > 0 && rate.denominator > 0) {
    return rate.numerator / rate.denominator;
  }
  return 1;
}

/**
 * Reassert only native-owned per-clip media state. During playback currentTime
 * is deliberately left alone so the base media clock can advance smoothly.
 */
function applyNativeMediaTransport(
  document: Document,
  clips: readonly NativePlaybackClipBinding[],
  frameRate: RationalFrameRate,
  projectFrame: number,
  synchronizeCurrentTime: boolean,
  activeClipIds: Set<string>,
): void {
  for (const clip of clips) {
    if (
      clip.assetId === undefined ||
      clip.sourceInFrame === undefined ||
      clip.muted === undefined
    ) continue;
    const media = findNativeClipMedia(document, clip);
    if (!media) continue;
    const localFrame = projectFrame - clip.startFrame;
    const active = localFrame >= 0 && localFrame < clip.durationFrames;
    const entering = active && !activeClipIds.has(clip.clipId);
    if (active) activeClipIds.add(clip.clipId);
    else activeClipIds.delete(clip.clipId);
    const playbackRate = resolveClipPlaybackRate(clip.playbackRate);
    media.playbackRate = playbackRate;
    // Inactive audio must never leak from a hidden clip. Authored unmute is
    // restored on the exact first active frame.
    media.muted = !active || clip.muted;
    if ((!synchronizeCurrentTime && !entering) || !active) continue;
    const sourceFrame = clip.sourceInFrame + localFrame * playbackRate;
    media.currentTime = (sourceFrame * frameRate.denominator) / frameRate.numerator;
  }
}

export function projectFrameAtSeconds(
  seconds: number,
  frameRate: RationalFrameRate,
  durationFrames: number,
): number {
  const rate = validateRationalFrameRate(frameRate);
  const frameCount = validateDurationFrames(durationFrames);
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  // Floor selects the frame whose interval contains the time. The epsilon only
  // repairs binary floating-point error at exact rational frame boundaries.
  const frame = Math.floor((safeSeconds * rate.numerator) / rate.denominator + 1e-9);
  return Math.min(frameCount - 1, frame);
}

/** Create the native seek/play transport used by both Studio preview and capture. */
export function createNativePlaybackAdapter(
  options: NativePlaybackAdapterOptions,
): NativePlaybackAdapter {
  const frameRate = validateRationalFrameRate(options.frameRate);
  const nativeDurationFrames = validateDurationFrames(options.durationFrames);
  const nativeDurationSeconds =
    (nativeDurationFrames * frameRate.denominator) / frameRate.numerator;
  const baseAdapter = options.baseAdapter ?? null;
  const baseDurationSeconds = baseAdapter ? getAdapterDuration(baseAdapter) : 0;
  // A native sidecar may own only the editable clips while a retained legacy
  // transport carries a longer audio/video composition. The wrapper must cover
  // both or adapter selection rejects it and native interpolation never runs.
  const durationSeconds = Math.max(nativeDurationSeconds, baseDurationSeconds);
  const durationFrames = Math.max(
    nativeDurationFrames,
    Math.ceil((durationSeconds * frameRate.numerator) / frameRate.denominator),
  );
  let renderedTime = 0;
  const activeNativeMediaClipIds = new Set<string>();

  const renderOnlyPlayer = {
    getTime: () => renderedTime,
    renderSeek: (time: number) => {
      renderedTime = Math.max(0, Math.min(durationSeconds, Number.isFinite(time) ? time : 0));
      applyNativeFrameToDocument(
        options.document,
        options.clips,
        projectFrameAtSeconds(renderedTime, frameRate, durationFrames),
      );
      applyNativeMediaTransport(
        options.document,
        options.clips,
        frameRate,
        projectFrameAtSeconds(renderedTime, frameRate, durationFrames),
        false,
        activeNativeMediaClipIds,
      );
    },
  };
  const transport = createStaticSeekPlaybackAdapter(
    renderOnlyPlayer,
    durationSeconds,
    options.clock,
    options.getPlaybackRate,
  );
  renderOnlyPlayer.renderSeek(0);

  const synchronizeNativeMedia = () => {
    applyNativeMediaTransport(
      options.document,
      options.clips,
      frameRate,
      projectFrameAtSeconds(transport.getTime(), frameRate, durationFrames),
      true,
      activeNativeMediaClipIds,
    );
  };
  synchronizeNativeMedia();

  const seekBoth = (time: number, seekOptions?: Parameters<PlaybackAdapter["seek"]>[1]) => {
    // Legacy media/GSAP seeks first; native-owned picture values apply last and
    // therefore remain authoritative for the channels in the sidecar.
    baseAdapter?.seek(time, seekOptions);
    transport.seek(time, seekOptions);
    synchronizeNativeMedia();
  };

  return {
    play: () => {
      if (transport.getTime() >= durationSeconds) seekBoth(0);
      baseAdapter?.play();
      transport.play();
      synchronizeNativeMedia();
    },
    pause: () => {
      transport.pause();
      baseAdapter?.pause();
      synchronizeNativeMedia();
    },
    seek: seekBoth,
    getTime: transport.getTime,
    getDuration: transport.getDuration,
    isPlaying: transport.isPlaying,
    renderSeek: (time: number) => {
      seekBoth(time, { keepPlaying: transport.isPlaying() });
    },
    dispose: () => {
      transport.pause();
    },
  };
}

/** Native state is authoritative only when it covers the full active document. */
export function selectPreferredNativePlaybackAdapter(
  win: NativePlaybackWindowLike,
  documentDuration: number,
): PlaybackAdapter | null {
  const native = win.__studioNativePlayer;
  if (!native) return null;
  const duration = getAdapterDuration(native);
  const safeDocumentDuration = Math.max(0, Number.isFinite(documentDuration) ? documentDuration : 0);
  return duration > 0 && duration >= safeDocumentDuration ? native : null;
}
