import {
  PREVIEW_GSAP_CHANNELS,
  type PreviewGsapChannel,
  type PreviewGsapKeyframe,
  type PreviewGsapObservation,
  type PreviewGsapTween,
} from "../../../shared/preview/agentProtocol";

const channels = new Set<string>(PREVIEW_GSAP_CHANNELS);
const META = new Set(["id", "duration", "ease", "easeEach", "delay", "stagger", "overwrite",
  "immediateRender", "lazy", "repeat", "repeatDelay", "yoyo", "paused", "parent",
  "onComplete", "onUpdate", "onStart", "onRepeat", "data", "keyframes", "motionPath",
  "runBackwards", "startAt"]);

type RuntimeTween = {
  targets?: () => Element[];
  vars?: Record<string, unknown>;
  duration?: () => number;
  startTime?: () => number;
};
type RuntimeTimeline = {
  getChildren?: (deep: boolean) => RuntimeTween[];
  time?: () => number;
};
type GsapWindow = Window & {
  gsap?: { getProperty?: (target: Element, property: string) => unknown };
  __timelines?: Record<string, RuntimeTimeline>;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function scalarProperties(value: Record<string, unknown>): {
  properties: Partial<Record<PreviewGsapChannel, number>>;
  complete: boolean;
} {
  const properties: Partial<Record<PreviewGsapChannel, number>> = {};
  let complete = true;
  for (const [key, entry] of Object.entries(value)) {
    if (channels.has(key)) {
      if (finite(entry)) properties[key as PreviewGsapChannel] = entry;
      else complete = false;
    } else if (!META.has(key)) complete = false;
  }
  return { properties, complete };
}

function keyframes(value: unknown): PreviewGsapKeyframe[] | null {
  if (!value || typeof value !== "object") return null;
  const frames = Array.isArray(value) ? value.map((frame, index) => [
    value.length < 2 ? 0 : index * 100 / (value.length - 1), frame,
  ] as const) : Object.entries(value).map(([key, frame]) => [
    key.endsWith("%") ? Number(key.slice(0, -1)) : Number.NaN, frame,
  ] as const);
  if (frames.length === 0 || frames.length > 64) return null;
  const result: PreviewGsapKeyframe[] = [];
  for (const [percentage, raw] of frames) {
    if (!finite(percentage) || percentage < 0 || percentage > 100 ||
        !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const values = raw as Record<string, unknown>;
    const parsed = scalarProperties(values);
    if (!parsed.complete || (values.ease !== undefined &&
        (typeof values.ease !== "string" || values.ease.length > 128))) return null;
    result.push({ percentage, properties: parsed.properties,
      ...(typeof values.ease === "string" ? { ease: values.ease } : {}) });
  }
  return result;
}

function motionPath(value: unknown): PreviewGsapTween["motionPath"] | null {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  if (!Array.isArray(value) && Object.keys(object).some(key =>
      !["path", "curviness", "autoRotate", "type"].includes(key))) return null;
  if (object.type !== undefined && object.type !== "cubic") return null;
  const path = Array.isArray(value) ? value : object.path;
  if (!Array.isArray(path) || path.length < 2 || path.length > 64) return null;
  const points: Array<{ x: number; y: number }> = [];
  for (const point of path) {
    if (!point || typeof point !== "object" || Array.isArray(point) ||
        Object.keys(point).length !== 2 || !Object.hasOwn(point, "x") ||
        !Object.hasOwn(point, "y") || !finite(point.x) || !finite(point.y)) return null;
    points.push({ x: point.x, y: point.y });
  }
  const curviness = object.curviness === undefined ? 1 : object.curviness;
  const autoRotate = object.autoRotate === undefined ? false : object.autoRotate;
  if (!finite(curviness) || Math.abs(curviness) > 10000 ||
      !(typeof autoRotate === "boolean" || finite(autoRotate))) return null;
  return { points, curviness, autoRotate, isCubic: object.type === "cubic" };
}

/** Observations are bounded and tied to one registered DOM object, never a selector. */
export function readPreviewGsapObservation(input: {
  view: Window;
  element: Element;
  handle: string;
  sourceFile: string;
  compositionPath: string;
  requestedChannels: PreviewGsapChannel[];
  compositionId?: string;
}): PreviewGsapObservation {
  const { view, element, handle, sourceFile, compositionPath, requestedChannels, compositionId } = input;
  const runtime = view as GsapWindow;
  const values: PreviewGsapObservation["values"] = {};
  for (const channel of requestedChannels) {
    try {
      const value = runtime.gsap?.getProperty?.(element, channel);
      const numeric = typeof value === "string" ? Number(value) : value;
      if (finite(numeric)) values[channel] = numeric;
    } catch { /* An unavailable live channel is omitted, never invented. */ }
  }
  const timelines = runtime.__timelines ?? {};
  const entries = Object.entries(timelines).filter(([id]) =>
    id !== "__proxied" && (!compositionId || id === compositionId));
  if (entries.length > 16) throw new Error("unsupported-action");
  const tweens: PreviewGsapTween[] = [];
  for (const [timelineId, timeline] of entries) {
    if (timelineId.length > 128 || typeof timeline?.getChildren !== "function") continue;
    const children = timeline.getChildren(true);
    if (!Array.isArray(children) || children.length > 1000) throw new Error("unsupported-action");
    const timelineTime = typeof timeline.time === "function" ? timeline.time() : null;
    if (timelineTime !== null && (!finite(timelineTime) || Math.abs(timelineTime) > 86400)) {
      throw new Error("unsupported-action");
    }
    for (const [tweenIndex, tween] of children.entries()) {
      if (!tween?.vars || typeof tween.targets !== "function") continue;
      const targets = tween.targets();
      if (!Array.isArray(targets) || targets.length > 1000) throw new Error("unsupported-action");
      const targetIndex = targets.indexOf(element);
      if (targetIndex < 0) continue;
      if (tweens.length >= 64) throw new Error("unsupported-action");
      const start = typeof tween.startTime === "function" ? tween.startTime() : 0;
      const duration = typeof tween.duration === "function" ? tween.duration() : 0;
      if (!finite(start) || Math.abs(start) > 86400 || !finite(duration) ||
          duration < 0 || duration > 86400) throw new Error("unsupported-action");
      const vars = tween.vars;
      const scalars = scalarProperties(vars);
      const startAt = vars.startAt;
      const from = startAt !== undefined && startAt !== null &&
        typeof startAt === "object" && !Array.isArray(startAt)
        ? scalarProperties(startAt as Record<string, unknown>) : null;
      const method = startAt !== undefined ? "fromTo" as const
        : vars.runBackwards === true || vars.runBackwards === 1 ? "from" as const : undefined;
      const frames = vars.keyframes === undefined ? undefined : keyframes(vars.keyframes);
      const path = vars.motionPath === undefined ? undefined : motionPath(vars.motionPath);
      const animationId = typeof vars.id === "string" && vars.id.length <= 128 ? vars.id : undefined;
      tweens.push({ timelineId, tweenIndex, targetIndex, start, duration, timelineTime,
        properties: scalars.properties,
        ...(method ? { method } : {}),
        ...(from ? { fromProperties: from.properties } : {}),
        ...(animationId ? { animationId } : {}),
        ...(frames ? { keyframes: frames } : {}),
        ...(path ? { motionPath: path } : {}),
        complete: scalars.complete && (startAt === undefined || Boolean(from?.complete))
          && (vars.runBackwards === undefined || vars.runBackwards === true || vars.runBackwards === 1)
          && (vars.keyframes === undefined || frames !== null)
          && (vars.motionPath === undefined || path !== null),
      });
    }
  }
  return {
    handle,
    id: element.id.slice(0, 256),
    hfId: (element.getAttribute("data-hf-id") ?? "").slice(0, 256),
    sourceFile: sourceFile.slice(0, 512),
    compositionPath: compositionPath.slice(0, 512),
    values,
    tweens,
  };
}
