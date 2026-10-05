import type { PreviewElementState, PreviewRect } from "../../../shared/preview/agentProtocol";
import type { NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { evaluateNativeParameterTrack } from "../../../shared/project/nativeKeyframeEvaluator";
import { applyNativeProjectPropertyCommand, type NativeProjectAtomicPropertyCommand } from "../../../shared/project/nativeProjectPropertyCommands";
import { markNativeCropPivotIntervals } from "../../../shared/project/nativeCropPivotSegments";
import type { NativeKeyframeProjectCommit } from "../../player/components/deleteSelectedKeyframes";
import { parseInsetClipPathSides } from "../inspector/clipPathHelpers";
import { resolveRemoteNativeClip } from "./remoteNativePreviewEdit";

type Pose = { rotation: number; x: number; y: number; scaleX: number; scaleY: number };
type CropRotationPlan = { clipId: string; trackId: string; localFrame: number;
  fraction: { x: number; y: number }; width: number; height: number;
  pose: Pose; animated: boolean };

const pixels = (value: string | undefined): number | null => {
  const match = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(value ?? "");
  const number = match ? Number(match[1]) : NaN;
  return Number.isFinite(number) && number > 0 && number <= 32768 ? number : null;
};

/** Selection chrome follows the visible inset, while crop controls still use
 * the full source box. Agent rectangles and computed pixels share iframe CSS
 * coordinates even when the editor scales the iframe to 206% or beyond. */
export function remoteVisibleCropRect(state: PreviewElementState): PreviewRect | null {
  const width = pixels(state.computedStyles.width);
  const height = pixels(state.computedStyles.height);
  const crop = state.inlineStyles["clip-path"] || state.computedStyles["clip-path"];
  const insets = parseInsetClipPathSides(crop ?? "");
  if (!width || !height || !insets || !(insets.top || insets.right || insets.bottom || insets.left) ||
    insets.left + insets.right >= width || insets.top + insets.bottom >= height ||
    !centeredOrigin(state.computedStyles["transform-origin"], width, height)) return null;
  const transform = state.computedStyles.transform;
  let matrix = [1, 0, 0, 1];
  if (transform && transform !== "none") {
    const match = /^matrix\(([^)]+)\)$/.exec(transform);
    if (!match) return null;
    matrix = match[1]!.split(",").map(Number).slice(0, 4);
    if (matrix.length !== 4 || matrix.some(value => !Number.isFinite(value))) return null;
  }
  const [a, b, c, d] = matrix as [number, number, number, number];
  const fullWidth = Math.abs(a) * width + Math.abs(c) * height;
  const fullHeight = Math.abs(b) * width + Math.abs(d) * height;
  if (Math.abs(state.rect.width - fullWidth) > 1.5 ||
    Math.abs(state.rect.height - fullHeight) > 1.5) return null;
  const offsetX = (insets.left - insets.right) / 2;
  const offsetY = (insets.top - insets.bottom) / 2;
  const visibleWidth = Math.abs(a) * (width - insets.left - insets.right) +
    Math.abs(c) * (height - insets.top - insets.bottom);
  const visibleHeight = Math.abs(b) * (width - insets.left - insets.right) +
    Math.abs(d) * (height - insets.top - insets.bottom);
  const centerX = state.rect.x + state.rect.width / 2 + a * offsetX + c * offsetY;
  const centerY = state.rect.y + state.rect.height / 2 + b * offsetX + d * offsetY;
  return { x: centerX - visibleWidth / 2, y: centerY - visibleHeight / 2,
    width: visibleWidth, height: visibleHeight };
}

function centeredOrigin(value: string | undefined, width: number, height: number): boolean {
  const origin = value?.trim().toLowerCase();
  if (!origin || origin === "center" || origin === "center center" || origin === "50% 50%") return true;
  const match = /^(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+0px)?$/.exec(origin);
  return Boolean(match && Math.abs(Number(match[1]) - width / 2) < 0.75 &&
    Math.abs(Number(match[2]) - height / 2) < 0.75);
}

/** Compare the live matrix with saved native pose. Authored GSAP/skew/3D
 * transforms must not be silently reinterpreted as a native crop pivot. */
function matchesNativePose(state: PreviewElementState, pose: Pose, width: number, height: number): boolean {
  const transform = state.computedStyles.transform;
  const radians = pose.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const expected = [pose.scaleX * cosine, pose.scaleX * sine,
    -pose.scaleY * sine, pose.scaleY * cosine, pose.x, pose.y];
  let actual: number[];
  if (!transform || transform === "none") actual = [1, 0, 0, 1, 0, 0];
  else {
    const match = /^matrix\(([^)]+)\)$/.exec(transform);
    if (!match) return false;
    actual = match[1]!.split(",").map(Number);
    if (actual.length !== 6 || actual.some(value => !Number.isFinite(value))) return false;
  }
  if (actual.some((value, index) => Math.abs(value - expected[index]!) > (index < 4 ? 0.002 : 0.75))) return false;
  const projectedWidth = Math.abs(actual[0]!) * width + Math.abs(actual[2]!) * height;
  const projectedHeight = Math.abs(actual[1]!) * width + Math.abs(actual[3]!) * height;
  return Math.abs(state.rect.width - projectedWidth) < 1.5 &&
    Math.abs(state.rect.height - projectedHeight) < 1.5;
}

/** Only the saved native pose and a simple axis-aligned inset may contribute
 * to this edit. Animated edits are anchored on an existing rotation key; the
 * derived interval correction then preserves every other authored key pose. */
export function planRemoteNativeCropRotation(
  document: NativeProjectDocument,
  state: PreviewElementState,
  projectFrame: number,
): CropRotationPlan | null {
  if (!Number.isInteger(projectFrame)) return null;
  const located = resolveRemoteNativeClip(document, state);
  if (!located || !state.visible || state.computedStyles["transform-origin"] === undefined) return null;
  const { clip, trackId } = located;
  const asset = document.assets.find(item => item.id === clip.assetId);
  if ((state.tag !== "video" && state.tag !== "img") ||
    (asset?.kind !== "video" && asset?.kind !== "image")) return null;
  const localFrame = projectFrame - clip.startFrame;
  if (localFrame < 0 || localFrame >= clip.durationFrames) return null;
  const width = pixels(state.computedStyles.width);
  const height = pixels(state.computedStyles.height);
  if (!width || !height || !centeredOrigin(state.computedStyles["transform-origin"], width, height)) return null;
  const crop = state.inlineStyles["clip-path"] || state.computedStyles["clip-path"];
  const insets = parseInsetClipPathSides(crop ?? "");
  if (!insets || !(insets.top || insets.right || insets.bottom || insets.left) ||
    insets.left + insets.right >= width || insets.top + insets.bottom >= height) return null;
  const tracks = new Map(clip.parameterTracks.map(track => [track.parameterId, track]));
  if (["transform.position", "transform.position.z", "transform.rotationX", "transform.rotationY",
    "transform.scaleZ", "transform.perspective"].some(id => tracks.has(id) || clip.staticParameters?.[id] !== undefined)) return null;
  const number = (id: string, fallback: number): number | null => {
    const track = tracks.get(id);
    const value = track ? evaluateNativeParameterTrack(track, localFrame)
      : clip.staticParameters?.[id] ?? fallback;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const rotation = number("transform.rotation", 0);
  const x = number("transform.position.x", 0);
  const y = number("transform.position.y", 0);
  const scale = number("transform.scale", 1);
  const scaleX = number("transform.scaleX", scale ?? 1);
  const scaleY = number("transform.scaleY", scale ?? 1);
  if ([rotation, x, y, scaleX, scaleY].some(value => value === null) ||
    !scaleX || !scaleY) return null;
  const pose = { rotation: rotation!, x: x!, y: y!, scaleX, scaleY };
  if (!matchesNativePose(state, pose, width, height)) return null;
  const animated = tracks.has("transform.rotation");
  if (animated) {
    const rotationTrack = tracks.get("transform.rotation")!;
    if (!rotationTrack.keyframes.some(key => key.frame === localFrame) ||
      !tracks.has("transform.position.x") || !tracks.has("transform.position.y") ||
      clip.parameterTracks.some(track => track.keyframes.some(key => key.outgoingPath))) return null;
  } else if (["transform.position.x", "transform.position.y", "transform.scale",
    "transform.scaleX", "transform.scaleY", "layout.width", "layout.height"].some(id => tracks.has(id))) {
    return null;
  }
  return { clipId: clip.id, trackId, localFrame, width, height, animated, pose,
    fraction: { x: (insets.left - insets.right) / (2 * width),
      y: (insets.top - insets.bottom) / (2 * height) } };
}

/** One durable revision and one Undo entry for the keyed pose and its pivot
 * interval metadata. Source trim/rate fields are carried through unchanged. */
export async function commitRemoteNativeCropRotation(
  document: NativeProjectDocument,
  state: PreviewElementState,
  projectFrame: number,
  deltaDegrees: number,
  commit: (change: NativeKeyframeProjectCommit) => Promise<boolean>,
): Promise<boolean> {
  if (!Number.isFinite(deltaDegrees) || Math.abs(deltaDegrees) > 3600) return false;
  const plan = planRemoteNativeCropRotation(document, state, projectFrame);
  if (!plan) return false;
  if (deltaDegrees === 0) return true;
  const { pose, fraction, width, height, localFrame } = plan;
  const offset = (angle: number) => {
    const radians = angle * Math.PI / 180;
    const dx = fraction.x * width * pose.scaleX;
    const dy = fraction.y * height * pose.scaleY;
    return { x: dx * Math.cos(radians) - dy * Math.sin(radians),
      y: dx * Math.sin(radians) + dy * Math.cos(radians) };
  };
  const before = offset(pose.rotation);
  const after = offset(pose.rotation + deltaDegrees);
  const values = { "transform.rotation": pose.rotation + deltaDegrees,
    "transform.position.x": pose.x + before.x - after.x,
    "transform.position.y": pose.y + before.y - after.y };
  const commands: NativeProjectAtomicPropertyCommand[] = Object.entries(values).map(([parameterId, value]) => {
    const address = { sequenceId: document.sequence.id, trackId: plan.trackId,
      clipId: plan.clipId, parameterId };
    return plan.animated ? { type: "upsert", address, value, valueType: "number",
      frame: localFrame, baselineValue: parameterId === "transform.rotation" ? pose.rotation
        : parameterId === "transform.position.x" ? pose.x : pose.y }
      : { type: "set-static", address, value };
  });
  const result = applyNativeProjectPropertyCommand(document, { type: "batch", commands });
  if (!result.ok) return false;
  const next = plan.animated
    ? markNativeCropPivotIntervals(result.document, plan.clipId, localFrame, fraction)
    : result.document;
  return commit({ document: next, inverse: { type: "restore-document", document },
    label: "Rotate cropped layer" });
}
