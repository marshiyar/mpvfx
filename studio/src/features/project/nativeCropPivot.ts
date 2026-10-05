import type { NativeCropPivotSegment } from "../../../shared/project/nativeProjectDocumentTypes";
import type { NativeParameterTrack, Vec2Value } from "../../../shared/project/nativeKeyframeTypes";

export interface CropPivotPose {
  position: Vec2Value;
  rotation: number;
  scale: Vec2Value;
  width: number | null;
  height: number | null;
  depth: number;
  rotationX: number;
  rotationY: number;
  perspective: number;
  autoRotateDegrees: number;
}

const GEOMETRY_PARAMETERS = new Set([
  "transform.position", "transform.position.x", "transform.position.y",
  "transform.rotation", "transform.scale", "transform.scaleX", "transform.scaleY",
  "layout.width", "layout.height",
]);

function sourceSize(element: HTMLElement, pose: CropPivotPose): Vec2Value | null {
  const view = element.ownerDocument.defaultView;
  const computed = view?.getComputedStyle(element);
  const width = pose.width ?? Number.parseFloat(element.style.width || computed?.width || "");
  const height = pose.height ?? Number.parseFloat(element.style.height || computed?.height || "");
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { x: width, y: height } : null;
}

function centeredOrigin(element: HTMLElement, size: Vec2Value): boolean {
  const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
  const value = (computed?.transformOrigin || element.style.transformOrigin).trim().toLowerCase();
  if (!value || value === "center" || value === "center center" || value === "50% 50%") return true;
  const px = /^(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+0px)?$/.exec(value);
  // Computed percentages resolve against the element's CURRENT DOM box. The
  // native frame's new width/height have not been applied at this point.
  const currentWidth = Number.parseFloat(element.style.width || computed?.width || "");
  const currentHeight = Number.parseFloat(element.style.height || computed?.height || "");
  const basis = { x: currentWidth > 0 ? currentWidth : size.x,
    y: currentHeight > 0 ? currentHeight : size.y };
  return Boolean(px && Math.abs(Number(px[1]) - basis.x / 2) < 1e-6 &&
    Math.abs(Number(px[2]) - basis.y / 2) < 1e-6);
}

function rotatedOffset(pose: CropPivotPose, size: Vec2Value, fraction: Vec2Value): Vec2Value {
  const angle = (pose.rotation + pose.autoRotateDegrees) * Math.PI / 180;
  const x = size.x * fraction.x * pose.scale.x;
  const y = size.y * fraction.y * pose.scale.y;
  return { x: x * Math.cos(angle) - y * Math.sin(angle),
    y: x * Math.sin(angle) + y * Math.cos(angle) };
}

function planar(pose: CropPivotPose): boolean {
  return pose.depth === 0 && pose.rotationX === 0 && pose.rotationY === 0 && pose.perspective === 0;
}

/** A derived render offset only. Authored tracks and all keyed poses remain intact. */
export function nativeCropPivotCorrection(input: {
  element: HTMLElement;
  segments: readonly NativeCropPivotSegment[] | undefined;
  tracks: readonly NativeParameterTrack[];
  frame: number;
  pose: CropPivotPose;
  evaluateAt: (frame: number) => CropPivotPose;
  evaluateReferenceAt?: (segment: NativeCropPivotSegment, frame: number) => CropPivotPose;
}): Vec2Value | null {
  const { element, segments, tracks, frame, pose, evaluateAt, evaluateReferenceAt } = input;
  if (!segments?.length || !planar(pose)) return null;
  const rotationTrack = tracks.find((track) => track.parameterId === "transform.rotation");
  if (!rotationTrack) return null;

  for (const segment of segments) {
    const start = rotationTrack.keyframes.find((key) => key.id === segment.startRotationKeyId)?.frame;
    const end = rotationTrack.keyframes.find((key) => key.id === segment.endRotationKeyId)?.frame;
    if (start === undefined || end === undefined || end <= start || frame < start || frame > end) continue;
    if (segment.reference && evaluateReferenceAt) {
      const reference = segment.reference;
      const sourceFrame = frame + reference.frameOffset;
      return nativeCropPivotCorrection({
        element,
        segments: [{
          startRotationKeyId: reference.startRotationKeyId,
          endRotationKeyId: reference.endRotationKeyId,
          offsetFraction: segment.offsetFraction,
        }],
        tracks: reference.parameterTracks,
        frame: sourceFrame,
        pose: evaluateReferenceAt(segment, sourceFrame),
        evaluateAt: (at) => evaluateReferenceAt(segment, at),
      });
    }
    if (frame === start || frame === end) return null;

    // Every existing geometry key is a protected pose. Split the derived
    // correction at those frames, including later keys added inside a segment.
    const boundaries = new Set([start, end]);
    for (const track of tracks) {
      if (!GEOMETRY_PARAMETERS.has(track.parameterId)) continue;
      for (const key of track.keyframes) {
        if (key.frame > start && key.frame < end) boundaries.add(key.frame);
      }
    }
    const frames = [...boundaries].sort((a, b) => a - b);
    const upper = frames.findIndex((boundary) => boundary >= frame);
    if (upper < 0 || frames[upper] === frame || upper === 0) return null;
    const first = frames[upper - 1]!;
    const last = frames[upper]!;
    // A designed vec2 motion path can loop between its keys. Deriving progress
    // from a coordinate would rewrite that authored shape, so leave it alone.
    const positionPath = tracks.find((track) => track.parameterId === "transform.position");
    const activePositionKey = positionPath?.keyframes.filter((key) => key.frame <= frame).at(-1);
    if (activePositionKey?.outgoingPath) return null;

    const before = evaluateAt(first);
    const after = evaluateAt(last);
    if (!planar(before) || !planar(after)) return null;
    const size = sourceSize(element, pose);
    const sizeBefore = sourceSize(element, before);
    const sizeAfter = sourceSize(element, after);
    if (!size || !sizeBefore || !sizeAfter || !centeredOrigin(element, size)) return null;
    const currentOffset = rotatedOffset(pose, size, segment.offsetFraction);
    const startOffset = rotatedOffset(before, sizeBefore, segment.offsetFraction);
    const endOffset = rotatedOffset(after, sizeAfter, segment.offsetFraction);
    const rotationDelta = after.rotation - before.rotation;
    const fallbackProgress = Math.abs(rotationDelta) > 1e-9
      ? (pose.rotation - before.rotation) / rotationDelta
      : (frame - first) / (last - first);
    const axis = (component: "x" | "y") => {
      const positionDelta = after.position[component] - before.position[component];
      const progress = Math.abs(positionDelta) > 1e-9
        ? (pose.position[component] - before.position[component]) / positionDelta
        : fallbackProgress;
      return startOffset[component] +
        (endOffset[component] - startOffset[component]) * progress - currentOffset[component];
    };
    const correction = { x: axis("x"), y: axis("y") };
    return Number.isFinite(correction.x) && Number.isFinite(correction.y) ? correction : null;
  }
  return null;
}
