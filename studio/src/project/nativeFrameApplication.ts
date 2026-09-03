import { evaluateNativeParameterTrack } from "./nativeKeyframeEvaluator";
import type {
  NativeParameterTrack,
  NativeParameterValue,
  Vec2Value,
} from "./nativeKeyframeTypes";

export const NATIVE_CLIP_ID_ATTRIBUTE = "data-studio-clip-id";
export const NATIVE_OWNED_PARAMETERS_ATTRIBUTE = "data-studio-native-owned";

export interface NativeClipFrameBinding {
  readonly clipId: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  /** Non-animated parameter base values. Animated tracks take precedence. */
  readonly staticParameters?: Readonly<Record<string, NativeParameterValue>>;
  readonly parameterTracks: readonly NativeParameterTrack[];
}

export interface NativeFrameApplicationResult {
  readonly appliedClipIds: string[];
  readonly missingClipIds: string[];
}

interface NativeVisualState {
  position: Vec2Value;
  depth: number;
  rotation: number;
  rotationX: number;
  rotationY: number;
  scale: Vec2Value;
  scaleZ: number;
  perspective: number;
  opacity: number;
  width: number | null;
  height: number | null;
  ownedParameters: string[];
}

const PARAMETER_ORDER = [
  "transform.position",
  "transform.position.x",
  "transform.position.y",
  "transform.position.z",
  "transform.rotation",
  "transform.rotationX",
  "transform.rotationY",
  "transform.scale",
  "transform.scaleX",
  "transform.scaleY",
  "transform.scaleZ",
  "transform.perspective",
  "transform.opacity",
  "visual.opacity",
  "visual.autoAlpha",
  "layout.width",
  "layout.height",
] as const;

const TRANSFORM_PARAMETERS = new Set<string>([
  "transform.position",
  "transform.position.x",
  "transform.position.y",
  "transform.position.z",
  "transform.rotation",
  "transform.rotationX",
  "transform.rotationY",
  "transform.scale",
  "transform.scaleX",
  "transform.scaleY",
  "transform.scaleZ",
  "transform.perspective",
]);
const OPACITY_PARAMETERS = new Set<string>([
  "transform.opacity",
  "visual.opacity",
  "visual.autoAlpha",
]);

function formatCssNumber(value: number): string {
  if (Object.is(value, -0)) return "0";
  const rounded = Math.round(value * 1e12) / 1e12;
  return String(rounded);
}

function defaultVisualState(): NativeVisualState {
  return {
    position: { x: 0, y: 0 },
    depth: 0,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    scale: { x: 1, y: 1 },
    scaleZ: 1,
    perspective: 0,
    opacity: 1,
    width: null,
    height: null,
    ownedParameters: [],
  };
}

function evaluateVisualState(
  staticParameters: Readonly<Record<string, NativeParameterValue>> | undefined,
  tracks: readonly NativeParameterTrack[],
  localFrame: number,
): NativeVisualState {
  const state = defaultVisualState();
  const values = new Map<string, NativeParameterValue>();
  // Apply static values in canonical order so object insertion order cannot
  // change the resulting preview/export state. Tracks are then authoritative
  // for their matching parameter, while untouched static values remain intact.
  for (const parameterId of PARAMETER_ORDER) {
    const value = staticParameters?.[parameterId];
    if (value !== undefined) values.set(parameterId, value);
  }
  for (const track of tracks) {
    if (!PARAMETER_ORDER.includes(track.parameterId as (typeof PARAMETER_ORDER)[number])) continue;
    values.set(track.parameterId, evaluateNativeParameterTrack(track, localFrame));
  }

  const position = values.get("transform.position");
  if (position && typeof position === "object" && "x" in position && "y" in position) {
    state.position = { x: position.x, y: position.y };
  }
  const positionX = values.get("transform.position.x");
  const positionY = values.get("transform.position.y");
  const positionZ = values.get("transform.position.z");
  if (typeof positionX === "number") state.position = { ...state.position, x: positionX };
  if (typeof positionY === "number") state.position = { ...state.position, y: positionY };
  if (typeof positionZ === "number") state.depth = positionZ;
  const rotation = values.get("transform.rotation");
  if (typeof rotation === "number") state.rotation = rotation;
  const rotationX = values.get("transform.rotationX");
  const rotationY = values.get("transform.rotationY");
  if (typeof rotationX === "number") state.rotationX = rotationX;
  if (typeof rotationY === "number") state.rotationY = rotationY;
  const scale = values.get("transform.scale");
  if (typeof scale === "number") {
    state.scale = { x: scale, y: scale };
  } else if (scale && typeof scale === "object" && "x" in scale && "y" in scale) {
    state.scale = { x: scale.x, y: scale.y };
  }
  const scaleX = values.get("transform.scaleX");
  const scaleY = values.get("transform.scaleY");
  if (typeof scaleX === "number") state.scale = { ...state.scale, x: scaleX };
  if (typeof scaleY === "number") state.scale = { ...state.scale, y: scaleY };
  const scaleZ = values.get("transform.scaleZ");
  if (typeof scaleZ === "number") state.scaleZ = scaleZ;
  const perspective = values.get("transform.perspective");
  if (typeof perspective === "number") state.perspective = Math.max(0, perspective);
  const opacity =
    values.get("transform.opacity") ??
    values.get("visual.opacity") ??
    values.get("visual.autoAlpha");
  if (typeof opacity === "number") state.opacity = Math.max(0, Math.min(1, opacity));
  const width = values.get("layout.width");
  const height = values.get("layout.height");
  if (typeof width === "number") state.width = Math.max(0, width);
  if (typeof height === "number") state.height = Math.max(0, height);
  state.ownedParameters = PARAMETER_ORDER.filter((parameterId) => values.has(parameterId));
  return state;
}

function findClipElement(document: Document, clipId: string): HTMLElement | null {
  for (const candidate of document.querySelectorAll(`[${NATIVE_CLIP_ID_ATTRIBUTE}]`)) {
    // `iframe.contentWindow` is a WindowProxy. During soft navigation its
    // exposed HTMLElement constructor can advance to the new realm before the
    // live Document's existing nodes do, making a valid candidate fail
    // `instanceof document.defaultView.HTMLElement`. The selector already
    // guarantees an Element; use the exact attribute identity instead.
    if (candidate.getAttribute(NATIVE_CLIP_ID_ATTRIBUTE) === clipId) {
      return candidate as HTMLElement;
    }
  }
  return null;
}

function applyVisualState(element: HTMLElement, state: NativeVisualState): void {
  const previousOwned = new Set(
    (element.getAttribute(NATIVE_OWNED_PARAMETERS_ATTRIBUTE) ?? "")
      .split(/\s+/)
      .filter(Boolean),
  );
  const ownsTransform = state.ownedParameters.some((id) => TRANSFORM_PARAMETERS.has(id));
  const ownedTransformBefore = [...previousOwned].some((id) => TRANSFORM_PARAMETERS.has(id));
  const { position, depth, rotation, rotationX, rotationY, scale, scaleZ, perspective } = state;
  if (ownsTransform || ownedTransformBefore) {
    const owns3d = state.ownedParameters.some((id) =>
      id === "transform.position.z" ||
      id === "transform.rotationX" ||
      id === "transform.rotationY" ||
      id === "transform.scaleZ" ||
      id === "transform.perspective",
    ) || [...previousOwned].some((id) =>
      id === "transform.position.z" ||
      id === "transform.rotationX" ||
      id === "transform.rotationY" ||
      id === "transform.scaleZ" ||
      id === "transform.perspective",
    );
    element.style.transform = owns3d
      ? `${perspective > 0 ? `perspective(${formatCssNumber(perspective)}px) ` : ""}` +
        `translate3d(${formatCssNumber(position.x)}px, ${formatCssNumber(position.y)}px, ${formatCssNumber(depth)}px) ` +
        `rotateX(${formatCssNumber(rotationX)}deg) ` +
        `rotateY(${formatCssNumber(rotationY)}deg) ` +
        `rotate(${formatCssNumber(rotation)}deg) ` +
        `scale3d(${formatCssNumber(scale.x)}, ${formatCssNumber(scale.y)}, ${formatCssNumber(scaleZ)})`
      : `translate3d(${formatCssNumber(position.x)}px, ${formatCssNumber(position.y)}px, 0px) ` +
        `rotate(${formatCssNumber(rotation)}deg) ` +
        `scale(${formatCssNumber(scale.x)}, ${formatCssNumber(scale.y)})`;
  }
  const ownsOpacity = state.ownedParameters.some((id) => OPACITY_PARAMETERS.has(id));
  const ownedOpacityBefore = [...previousOwned].some((id) => OPACITY_PARAMETERS.has(id));
  if (ownsOpacity || ownedOpacityBefore) {
    element.style.opacity = formatCssNumber(state.opacity);
  }
  if (state.width !== null) element.style.width = `${formatCssNumber(state.width)}px`;
  else if (previousOwned.has("layout.width")) element.style.removeProperty("width");
  if (state.height !== null) element.style.height = `${formatCssNumber(state.height)}px`;
  else if (previousOwned.has("layout.height")) element.style.removeProperty("height");
  element.setAttribute(NATIVE_OWNED_PARAMETERS_ATTRIBUTE, state.ownedParameters.join(" "));
}

/**
 * Apply one deterministic native project frame to the preview/export document.
 * Both callers use this function, so paused seeks and captured frames cannot use
 * different interpolation or transform composition rules.
 */
export function applyNativeFrameToDocument(
  document: Document,
  clips: readonly NativeClipFrameBinding[],
  projectFrame: number,
): NativeFrameApplicationResult {
  if (!Number.isInteger(projectFrame)) {
    throw new TypeError("Native frames must be applied at an integer project frame");
  }
  const appliedClipIds: string[] = [];
  const missingClipIds: string[] = [];

  for (const clip of clips) {
    const element = findClipElement(document, clip.clipId);
    if (!element) {
      missingClipIds.push(clip.clipId);
      continue;
    }
    appliedClipIds.push(clip.clipId);
    const localFrame = projectFrame - clip.startFrame;
    const visible = localFrame >= 0 && localFrame < clip.durationFrames;
    element.style.visibility = visible ? "visible" : "hidden";
    if (!visible) continue;
    const state = evaluateVisualState(clip.staticParameters, clip.parameterTracks, localFrame);
    // A sidecar may include legacy-owned clips only to preserve timeline/media
    // structure. Do not claim their picture properties unless this revision has
    // native tracks, or an earlier revision already claimed them and now needs a reset.
    if (
      state.ownedParameters.length > 0 ||
      element.hasAttribute(NATIVE_OWNED_PARAMETERS_ATTRIBUTE)
    ) {
      applyVisualState(element, state);
    }
  }

  return { appliedClipIds, missingClipIds };
}
