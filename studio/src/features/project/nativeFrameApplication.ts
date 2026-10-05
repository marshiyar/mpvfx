import { applyNativeGestureDraft } from "./nativeGestureDraft";
import { nativeCropPivotCorrection } from "./nativeCropPivot";
import type { NativeCropPivotSegment } from "../../../shared/project/nativeProjectDocumentTypes";
import { evaluateNativeParameterTrack } from "../../../shared/project/nativeKeyframeEvaluator";
import { vkfEngine } from "../../../shared/engine/vkfEngine";
import type {
  NativeParameterTrack,
  NativeParameterValue,
  Vec2Value,
} from "../../../shared/project/nativeKeyframeTypes";

export const NATIVE_CLIP_ID_ATTRIBUTE = "data-studio-clip-id";
export const NATIVE_OWNED_PARAMETERS_ATTRIBUTE = "data-studio-native-owned";

export interface NativeClipFrameBinding {
  readonly clipId: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  /** Non-animated parameter base values. Animated tracks take precedence. */
  readonly staticParameters?: Readonly<Record<string, NativeParameterValue>>;
  readonly parameterTracks: readonly NativeParameterTrack[];
  readonly cropPivotSegments?: readonly NativeCropPivotSegment[];
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
  /** Transform components with a native value; the rest stay with the page. */
  ownedComponents: Set<TransformComponent>;
  /** Auto-rotate turn, added on top of whichever rotation is in effect. */
  autoRotateDegrees: number;
}

type TransformComponent =
  | "x" | "y" | "z" | "rotation" | "rotationX" | "rotationY"
  | "scaleX" | "scaleY" | "scaleZ" | "perspective";

// GSAP property read for each component the native renderer does not own.
// GSAP 3 has no scaleZ transform component, so it is never read back.
const GSAP_TRANSFORM_PROPERTIES: readonly (readonly [TransformComponent, string])[] = [
  ["x", "x"], ["y", "y"], ["z", "z"],
  ["rotation", "rotation"], ["rotationX", "rotationX"], ["rotationY", "rotationY"],
  ["scaleX", "scaleX"], ["scaleY", "scaleY"],
  ["perspective", "transformPerspective"],
];

/**
 * Transform values the page's GSAP last applied to this element, read from
 * GSAP's own cache (never re-parsed from the style the native renderer
 * writes). Native writes the element's whole transform, so a component it has
 * no value for keeps GSAP's instead of being reset. Null when GSAP never
 * touched the element.
 */
function gsapTransform(element: HTMLElement): Partial<Record<TransformComponent, number>> | null {
  if (!("_gsap" in element)) return null;
  const view = element.ownerDocument.defaultView as
    | { gsap?: { getProperty?: (target: Element, property: string) => unknown } }
    | null;
  const getProperty = view?.gsap?.getProperty;
  if (typeof getProperty !== "function") return null;
  const values: Partial<Record<TransformComponent, number>> = {};
  for (const [component, property] of GSAP_TRANSFORM_PROPERTIES) {
    const value = Number(getProperty(element, property));
    if (Number.isFinite(value)) values[component] = value;
  }
  return values;
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
    ownedComponents: new Set(),
    autoRotateDegrees: 0,
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
  // Auto-rotate: the layer also turns to face its direction of motion along
  // the position path (the engine reports it; y down, so clockwise positive).
  const positionTrack = tracks.find(
    (track) => track.parameterId === "transform.position" && track.autoRotate,
  );
  if (positionTrack) {
    const angle = vkfEngine().tangentAngle(positionTrack, localFrame);
    if (Number.isFinite(angle)) state.autoRotateDegrees = (angle * 180) / Math.PI;
  }
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
  const owns = (...parameterIds: string[]) => parameterIds.some((id) => values.has(id));
  const components: [TransformComponent, boolean][] = [
    ["x", owns("transform.position", "transform.position.x")],
    ["y", owns("transform.position", "transform.position.y")],
    ["z", owns("transform.position.z")],
    ["rotation", owns("transform.rotation")],
    ["rotationX", owns("transform.rotationX")],
    ["rotationY", owns("transform.rotationY")],
    ["scaleX", owns("transform.scale", "transform.scaleX")],
    ["scaleY", owns("transform.scale", "transform.scaleY")],
    ["scaleZ", owns("transform.scaleZ")],
    ["perspective", owns("transform.perspective")],
  ];
  state.ownedComponents = new Set(components.filter(([, owned]) => owned).map(([component]) => component));
  return state;
}

/**
 * The one element carrying this clip's identity. Two elements claiming the
 * same clip are ambiguous: neither is styled (never guess), in preview and
 * export alike.
 */
export function findClipElement(document: Document, clipId: string): HTMLElement | null {
  let found: HTMLElement | null = null;
  for (const candidate of document.querySelectorAll(`[${NATIVE_CLIP_ID_ATTRIBUTE}]`)) {
    // `iframe.contentWindow` is a WindowProxy. During soft navigation its
    // exposed HTMLElement constructor can advance to the new realm before the
    // live Document's existing nodes do, making a valid candidate fail
    // `instanceof document.defaultView.HTMLElement`. The selector already
    // guarantees an Element; use the exact attribute identity instead.
    if (candidate.getAttribute(NATIVE_CLIP_ID_ATTRIBUTE) === clipId) {
      if (found) return null;
      found = candidate as HTMLElement;
    }
  }
  return found;
}

function applyVisualState(element: HTMLElement, state: NativeVisualState): void {
  const previousOwned = new Set(
    (element.getAttribute(NATIVE_OWNED_PARAMETERS_ATTRIBUTE) ?? "")
      .split(/\s+/)
      .filter(Boolean),
  );
  const ownsTransform = state.ownedParameters.some((id) => TRANSFORM_PARAMETERS.has(id));
  const ownedTransformBefore = [...previousOwned].some((id) => TRANSFORM_PARAMETERS.has(id));
  if (ownsTransform || ownedTransformBefore) {
    const legacy = gsapTransform(element);
    const pick = (component: TransformComponent, native: number, fallback: number): number =>
      state.ownedComponents.has(component) ? native : legacy?.[component] ?? fallback;
    const x = pick("x", state.position.x, 0);
    const y = pick("y", state.position.y, 0);
    const depth = pick("z", state.depth, 0);
    const rotation = pick("rotation", state.rotation, 0) + state.autoRotateDegrees;
    const rotationX = pick("rotationX", state.rotationX, 0);
    const rotationY = pick("rotationY", state.rotationY, 0);
    const scaleX = pick("scaleX", state.scale.x, 1);
    const scaleY = pick("scaleY", state.scale.y, 1);
    const scaleZ = pick("scaleZ", state.scaleZ, 1);
    const perspective = Math.max(0, pick("perspective", state.perspective, 0));
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
    ) || depth !== 0 || rotationX !== 0 || rotationY !== 0 || scaleZ !== 1 || perspective > 0;
    element.style.transform = owns3d
      ? `${perspective > 0 ? `perspective(${formatCssNumber(perspective)}px) ` : ""}` +
        `translate3d(${formatCssNumber(x)}px, ${formatCssNumber(y)}px, ${formatCssNumber(depth)}px) ` +
        `rotateX(${formatCssNumber(rotationX)}deg) ` +
        `rotateY(${formatCssNumber(rotationY)}deg) ` +
        `rotate(${formatCssNumber(rotation)}deg) ` +
        `scale3d(${formatCssNumber(scaleX)}, ${formatCssNumber(scaleY)}, ${formatCssNumber(scaleZ)})`
      : `translate3d(${formatCssNumber(x)}px, ${formatCssNumber(y)}px, 0px) ` +
        `rotate(${formatCssNumber(rotation)}deg) ` +
        `scale(${formatCssNumber(scaleX)}, ${formatCssNumber(scaleY)})`;
  }
  const ownsOpacity = state.ownedParameters.some((id) => OPACITY_PARAMETERS.has(id));
  const ownedOpacityBefore = [...previousOwned].some((id) => OPACITY_PARAMETERS.has(id));
  if (ownsOpacity || ownedOpacityBefore) {
    const opacity = formatCssNumber(state.opacity);
    element.setAttribute("data-studio-native-opacity", opacity);
    // The grading renderer owns the source's opacity while its replacement
    // canvas is visible. Revealing it here draws the original over the effect.
    if (!element.hasAttribute("data-hf-color-grading-source-hidden")) {
      element.style.opacity = opacity;
    }
  } else {
    element.removeAttribute("data-studio-native-opacity");
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
    const visible = localFrame >= 0 && localFrame < clip.durationFrames &&
      !element.hasAttribute("data-hidden");
    const gradedPicture = element.id
      ? document.getElementById(`__hf_color_grading_${element.id}`)
      : null;
    const picture = gradedPicture?.hasAttribute("data-hf-color-grading-canvas")
      ? gradedPicture : null;
    if (picture) picture.style.visibility = visible ? "visible" : "hidden";
    element.style.visibility = visible ? "visible" : "hidden";
    if (!visible) continue;
    const state = evaluateVisualState(clip.staticParameters, clip.parameterTracks, localFrame);
    const cropPivot = state.ownedComponents.has("x") && state.ownedComponents.has("y")
      ? nativeCropPivotCorrection({
          element, segments: clip.cropPivotSegments, tracks: clip.parameterTracks,
          frame: localFrame, pose: state,
          evaluateAt: (frame) => evaluateVisualState(clip.staticParameters, clip.parameterTracks, frame),
          evaluateReferenceAt: (segment, frame) => evaluateVisualState(
            segment.reference?.staticParameters,
            segment.reference?.parameterTracks ?? clip.parameterTracks,
            frame,
          ),
        }) : null;
    if (cropPivot) state.position = {
      x: state.position.x + cropPivot.x,
      y: state.position.y + cropPivot.y,
    };
    // A sidecar may include legacy-owned clips only to preserve timeline/media
    // structure. Do not claim their picture properties unless this revision has
    // native tracks, or an earlier revision already claimed them and now needs a reset.
    if (
      state.ownedParameters.length > 0 ||
      element.hasAttribute(NATIVE_OWNED_PARAMETERS_ATTRIBUTE)
    ) {
      applyVisualState(element, state);
      applyNativeGestureDraft(element);
      if (picture) {
        // The effect canvas is a sibling, not a child: it does not inherit the
        // source transform, dimensions or alpha. Update it in this same pass.
        if (state.ownedParameters.some(id => TRANSFORM_PARAMETERS.has(id))) {
          picture.style.transform = element.style.transform;
        }
        const opacity = element.getAttribute("data-studio-native-opacity");
        if (opacity !== null) picture.style.opacity = opacity;
        if (state.width !== null) picture.style.width = element.style.width;
        if (state.height !== null) picture.style.height = element.style.height;
      }
    }
  }

  return { appliedClipIds, missingClipIds };
}
