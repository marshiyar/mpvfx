/** Messages exchanged with an authored preview running on its project origin. */
import type { NativeProjectDocument } from "../project/nativeProjectDocument";
import type { VkfBakedTrack } from "../engine/vkfEngine";
export const PREVIEW_AGENT_CHANNEL = "mpvfx.preview-agent" as const;
export const PREVIEW_AGENT_VERSION = 1 as const;

export type PreviewElementHandle = string;
export const PREVIEW_GSAP_CHANNELS = [
  "x", "y", "xPercent", "yPercent", "left", "top", "width", "height",
  "rotation", "rotationX", "rotationY", "rotationZ", "scale", "scaleX", "scaleY",
  "opacity", "autoAlpha", "zIndex", "skewX", "skewY", "transformPerspective",
] as const;
export type PreviewGsapChannel = typeof PREVIEW_GSAP_CHANNELS[number];
export type PreviewGsapKeyframe = {
  percentage: number;
  properties: Partial<Record<PreviewGsapChannel, number>>;
  ease?: string;
};
export type PreviewGsapTween = {
  timelineId: string;
  animationId?: string;
  tweenIndex: number;
  targetIndex: number;
  start: number;
  duration: number;
  timelineTime: number | null;
  properties: Partial<Record<PreviewGsapChannel, number>>;
  keyframes?: PreviewGsapKeyframe[];
  motionPath?: { points: Array<{ x: number; y: number }>; curviness: number; autoRotate: boolean | number; isCubic: boolean };
  /** False when the runtime tween contains data this bounded format omitted. */
  complete: boolean;
};
export type PreviewGsapObservation = {
  handle: PreviewElementHandle;
  id: string;
  hfId: string;
  sourceFile: string;
  compositionPath: string;
  values: Partial<Record<PreviewGsapChannel, number>>;
  tweens: PreviewGsapTween[];
};
export type PreviewBakedTrack = VkfBakedTrack & { clipId: string; trackId: string; referenceIndex?: number };
export type PreviewRect = { x: number; y: number; width: number; height: number };
export type PreviewElementState = {
  handle: PreviewElementHandle;
  tag: string;
  id: string;
  className: string;
  text: string;
  textEditable: boolean;
  rect: PreviewRect;
  visible: boolean;
  parent: PreviewElementHandle | null;
  selector?: string;
  selectorIndex?: number;
  sourceFile: string;
  compositionPath: string;
  dataAttributes: Record<string, string>;
  inlineStyles: Record<string, string>;
  computedStyles: Record<string, string>;
};

export type PreviewAgentCommand =
  | { kind: "snapshot"; offset?: number; limit?: number }
  | { kind: "hitTest"; x: number; y: number }
  | { kind: "readElement"; handle: PreviewElementHandle }
  | { kind: "readGsap"; handle: PreviewElementHandle; channels: PreviewGsapChannel[]; compositionId?: string }
  | { kind: "setStyle"; handle: PreviewElementHandle; property: string; value: string }
  | { kind: "setText"; handle: PreviewElementHandle; text: string }
  | { kind: "setAttribute"; handle: PreviewElementHandle; name: string; value: string }
  | { kind: "previewAudioGroup"; groupId: string; attribute: "data-volume" | "data-hidden" | "data-fx-chain" | "data-automation" | "data-label"; value: string | null }
  | { kind: "scrubAudio"; audioId: string; timeSeconds: number | null; volume: number }
  | { kind: "installNativeProject"; project: NativeProjectDocument; bakedTracks: PreviewBakedTrack[]; activeSourceFile: string; timeSeconds: number; playing: boolean };

export type PreviewAgentInit = {
  channel: typeof PREVIEW_AGENT_CHANNEL;
  version: typeof PREVIEW_AGENT_VERSION;
  type: "init";
  token: string;
};
export type PreviewAgentRequest = {
  channel: typeof PREVIEW_AGENT_CHANNEL;
  version: typeof PREVIEW_AGENT_VERSION;
  type: "request";
  token: string;
  id: number;
  command: PreviewAgentCommand;
};
export type PreviewAgentReply = {
  channel: typeof PREVIEW_AGENT_CHANNEL;
  version: typeof PREVIEW_AGENT_VERSION;
  type: "reply";
  token: string;
  id: number;
  ok: boolean;
  result?: PreviewElementState | PreviewElementState[] | PreviewGsapObservation | null;
  error?: "invalid-request" | "stale-handle" | "unsupported-action";
};
export type PreviewAgentReady = {
  channel: typeof PREVIEW_AGENT_CHANNEL;
  version: typeof PREVIEW_AGENT_VERSION;
  type: "ready";
  token: string;
};
export const PREVIEW_TRANSPORT_KEYS = [" ", "j", "k", "l", "ArrowLeft", "ArrowRight", "i", "o", "a", "e", "m"] as const;
export type PreviewTransportKey = typeof PREVIEW_TRANSPORT_KEYS[number];
export type PreviewTransportKeyEvent = {
  channel: typeof PREVIEW_AGENT_CHANNEL;
  version: typeof PREVIEW_AGENT_VERSION;
  type: "transport-key";
  token: string;
  phase: "down" | "up";
  key: PreviewTransportKey;
  shiftKey: boolean;
  repeat: boolean;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const boundedString = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit;
const handle = (value: unknown): value is string =>
  typeof value === "string" && /^e[1-9]\d{0,8}$/.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const channelSet = new Set<string>(PREVIEW_GSAP_CHANNELS);
const transportKeySet = new Set<string>(PREVIEW_TRANSPORT_KEYS);

export function isPreviewTransportKeyEvent(value: unknown): value is PreviewTransportKeyEvent {
  return record(value) && exactKeys(value,
    ["channel", "version", "type", "token", "phase", "key", "shiftKey", "repeat"])
    && value.channel === PREVIEW_AGENT_CHANNEL && value.version === PREVIEW_AGENT_VERSION
    && value.type === "transport-key" && boundedString(value.token, 128)
    && value.token.length >= 16 && (value.phase === "down" || value.phase === "up")
    && typeof value.key === "string" && transportKeySet.has(value.key)
    && typeof value.shiftKey === "boolean" && typeof value.repeat === "boolean";
}
const channelNumbers = (value: unknown): boolean =>
  record(value) && Object.keys(value).length <= PREVIEW_GSAP_CHANNELS.length &&
  Object.entries(value).every(([key, entry]) => channelSet.has(key) && finite(entry));
const boundedKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));

/** Validate authored-frame GSAP observations as bounded untrusted data. */
export function isPreviewGsapObservation(value: unknown): value is PreviewGsapObservation {
  if (!record(value) || !exactKeys(value,
    ["handle", "id", "hfId", "sourceFile", "compositionPath", "values", "tweens"])
    || !handle(value.handle) || !boundedString(value.id, 256)
    || !boundedString(value.hfId, 256) || !boundedString(value.sourceFile, 512)
    || !boundedString(value.compositionPath, 512) || !channelNumbers(value.values)
    || !Array.isArray(value.tweens) || value.tweens.length > 64) return false;
  return value.tweens.every(tween => {
    if (!record(tween) || !boundedKeys(tween,
      ["timelineId", "tweenIndex", "targetIndex", "start", "duration", "timelineTime", "properties", "complete"],
      ["animationId", "keyframes", "motionPath"])
      || !boundedString(tween.timelineId, 128)
      || (tween.animationId !== undefined && !boundedString(tween.animationId, 128))
      || !Number.isSafeInteger(tween.tweenIndex) || (tween.tweenIndex as number) < 0 || (tween.tweenIndex as number) > 1000
      || !Number.isSafeInteger(tween.targetIndex) || (tween.targetIndex as number) < 0 || (tween.targetIndex as number) > 1000
      || !finite(tween.start) || Math.abs(tween.start) > 86400
      || !finite(tween.duration) || tween.duration < 0 || tween.duration > 86400
      || (tween.timelineTime !== null && (!finite(tween.timelineTime) || Math.abs(tween.timelineTime) > 86400))
      || !channelNumbers(tween.properties) || typeof tween.complete !== "boolean") return false;
    if (tween.keyframes !== undefined && (!Array.isArray(tween.keyframes) || tween.keyframes.length > 64 ||
      !tween.keyframes.every(frame => record(frame) && boundedKeys(frame, ["percentage", "properties"], ["ease"])
        && finite(frame.percentage) && frame.percentage >= 0 && frame.percentage <= 100
        && channelNumbers(frame.properties) &&
        (frame.ease === undefined || boundedString(frame.ease, 128))))) return false;
    if (tween.motionPath !== undefined) {
      const path = tween.motionPath;
      if (!record(path) || !exactKeys(path, ["points", "curviness", "autoRotate", "isCubic"])
        || !Array.isArray(path.points) || path.points.length < 2 || path.points.length > 64
        || !path.points.every(point => record(point) && exactKeys(point, ["x", "y"])
          && finite(point.x) && finite(point.y))
        || !finite(path.curviness) || Math.abs(path.curviness) > 10000
        || !(typeof path.autoRotate === "boolean" || finite(path.autoRotate))
        || typeof path.isCubic !== "boolean") return false;
    }
    return true;
  });
}

export function isPreviewAgentInit(value: unknown): value is PreviewAgentInit {
  return record(value) && exactKeys(value, ["channel", "version", "type", "token"])
    && value.channel === PREVIEW_AGENT_CHANNEL && value.version === PREVIEW_AGENT_VERSION
    && value.type === "init" && boundedString(value.token, 128) && value.token.length >= 16;
}

export function isPreviewAgentRequest(value: unknown): value is PreviewAgentRequest {
  if (!record(value) || !exactKeys(value, ["channel", "version", "type", "token", "id", "command"])
    || value.channel !== PREVIEW_AGENT_CHANNEL || value.version !== PREVIEW_AGENT_VERSION
    || value.type !== "request" || !boundedString(value.token, 128) || value.token.length < 16
    || !Number.isSafeInteger(value.id) || (value.id as number) < 1 || !record(value.command)) return false;
  const command = value.command;
  switch (command.kind) {
    case "snapshot": return (exactKeys(command, ["kind"])
      || exactKeys(command, ["kind", "offset"])
      || exactKeys(command, ["kind", "limit"])
      || exactKeys(command, ["kind", "offset", "limit"]))
      && (command.offset === undefined || (Number.isSafeInteger(command.offset) && (command.offset as number) >= 0 && (command.offset as number) <= 100000))
      && (command.limit === undefined || (Number.isSafeInteger(command.limit) && (command.limit as number) >= 1 && (command.limit as number) <= 300));
    case "hitTest": return exactKeys(command, ["kind", "x", "y"])
      && typeof command.x === "number" && Number.isFinite(command.x)
      && typeof command.y === "number" && Number.isFinite(command.y);
    case "readElement": return exactKeys(command, ["kind", "handle"]) && handle(command.handle);
    case "readGsap": return (exactKeys(command, ["kind", "handle", "channels"])
      || exactKeys(command, ["kind", "handle", "channels", "compositionId"]))
      && handle(command.handle) && Array.isArray(command.channels)
      && command.channels.length > 0 && command.channels.length <= 21
      && new Set(command.channels).size === command.channels.length
      && command.channels.every(channel => PREVIEW_GSAP_CHANNELS.includes(channel as PreviewGsapChannel))
      && (command.compositionId === undefined || boundedString(command.compositionId, 128));
    case "setStyle": return exactKeys(command, ["kind", "handle", "property", "value"])
      && handle(command.handle) && boundedString(command.property, 64) && boundedString(command.value, 512);
    case "setText": return exactKeys(command, ["kind", "handle", "text"])
      && handle(command.handle) && boundedString(command.text, 4096);
    case "setAttribute": return exactKeys(command, ["kind", "handle", "name", "value"])
      && handle(command.handle) && boundedString(command.name, 64) && boundedString(command.value, 512);
    case "previewAudioGroup": {
      if (!exactKeys(command, ["kind", "groupId", "attribute", "value"])
        || typeof command.groupId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(command.groupId)
        || typeof command.attribute !== "string"
        || !["data-volume", "data-hidden", "data-fx-chain", "data-automation", "data-label"].includes(command.attribute)
        || (command.value !== null && !boundedString(command.value, 8192))) return false;
      if (command.attribute === "data-hidden") return command.value === null || command.value === "";
      if (command.attribute === "data-volume") {
        if (command.value === null || command.value === "") return true;
        if (typeof command.value !== "string" || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(command.value)) return false;
        const gain = Number(command.value);
        return Number.isFinite(gain) && gain >= 0 && gain <= 10 ** (12 / 20) + 0.0000005;
      }
      if (command.attribute === "data-label") return command.value === null ||
        (typeof command.value === "string" && command.value.length <= 256 && !/[\u0000-\u001f]/.test(command.value));
      return command.value === null || (typeof command.value === "string" && command.value.length <= 8192);
    }
    case "scrubAudio": return exactKeys(command, ["kind", "audioId", "timeSeconds", "volume"])
      && boundedString(command.audioId, 256) && command.audioId.length > 0
      && !/[\u0000-\u001f]/.test(command.audioId)
      && (command.timeSeconds === null || (finite(command.timeSeconds) && command.timeSeconds >= 0 && command.timeSeconds <= 86400))
      && finite(command.volume) && command.volume >= 0 && command.volume <= 1;
    case "installNativeProject": {
      if (!exactKeys(command, ["kind", "project", "bakedTracks", "activeSourceFile", "timeSeconds", "playing"])
        || !record(command.project) || !boundedString(command.activeSourceFile, 512)
        || typeof command.timeSeconds !== "number" || !Number.isFinite(command.timeSeconds)
        || command.timeSeconds < 0 || command.timeSeconds > 86400
        || typeof command.playing !== "boolean" || !Array.isArray(command.bakedTracks)
        || command.bakedTracks.length > 512) return false;
      let sampleCount = 0;
      for (const baked of command.bakedTracks) {
        if (!record(baked) || !boundedString(baked.clipId, 256) || !boundedString(baked.trackId, 256)
          || (baked.referenceIndex !== undefined && (!Number.isSafeInteger(baked.referenceIndex)
            || (baked.referenceIndex as number) < 0 || (baked.referenceIndex as number) > 1000))
          || !["number", "vec2", "rgba"].includes(String(baked.valueType))
          || !Array.isArray(baked.samples) || baked.samples.length > 1_000_000
          || !baked.samples.every(sample => typeof sample === "number" && Number.isFinite(sample))
          || (baked.angles !== undefined && (!Array.isArray(baked.angles)
            || baked.angles.length > 1_000_000
            || !baked.angles.every(angle => angle === null || (typeof angle === "number" && Number.isFinite(angle)))))) return false;
        sampleCount += baked.samples.length + (baked.angles?.length ?? 0);
        if (sampleCount > 4_000_000) return false;
      }
      try { return JSON.stringify(command).length <= 32 * 1024 * 1024; }
      catch { return false; }
    }
    default: return false;
  }
}
