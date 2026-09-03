import type { OverlayRect } from "./domEditOverlayGeometry";
import { hugOrientedRectForElement } from "./domEditOverlayCrop";

export interface CanvasEdges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MediaBounds extends CanvasEdges {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

type MediaRect = Pick<OverlayRect, "left" | "top" | "width" | "height" | "angle">;

const VISUAL_MEDIA_TAGS = new Set(["img", "video"]);

export function isCanvasBoundMediaElement(element: Element): boolean {
  return VISUAL_MEDIA_TAGS.has(element.tagName.toLowerCase());
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback;
}

/** Axis-aligned painted bounds of a center-rotated media border box. */
export function rotatedMediaBounds(rect: MediaRect): MediaBounds {
  const width = Math.max(0, finiteOr(rect.width, 0));
  const height = Math.max(0, finiteOr(rect.height, 0));
  const centerX = finiteOr(rect.left, 0) + width / 2;
  const centerY = finiteOr(rect.top, 0) + height / 2;
  const radians = (finiteOr(rect.angle, 0) * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const paintedWidth = width * cosine + height * sine;
  const paintedHeight = width * sine + height * cosine;
  const halfWidth = paintedWidth / 2;
  const halfHeight = paintedHeight / 2;
  return {
    left: centerX - halfWidth,
    top: centerY - halfHeight,
    right: centerX + halfWidth,
    bottom: centerY + halfHeight,
    width: paintedWidth,
    height: paintedHeight,
    centerX,
    centerY,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (minimum > maximum) return (minimum + maximum) / 2;
  return Math.min(maximum, Math.max(minimum, value));
}

function constrainAxis(input: {
  proposed: number;
  itemStart: number;
  itemEnd: number;
  canvasStart: number;
  canvasEnd: number;
}): number {
  const itemSize = input.itemEnd - input.itemStart;
  const canvasSize = input.canvasEnd - input.canvasStart;
  if (itemSize > canvasSize) {
    const itemCenter = (input.itemStart + input.itemEnd) / 2;
    const canvasCenter = (input.canvasStart + input.canvasEnd) / 2;
    return canvasCenter - itemCenter;
  }
  return clamp(
    finiteOr(input.proposed, 0),
    input.canvasStart - input.itemStart,
    input.canvasEnd - input.itemEnd,
  );
}

export function constrainMediaDragDelta(input: {
  rect: MediaRect;
  canvas: CanvasEdges;
  proposed: { dx: number; dy: number };
}): { dx: number; dy: number } {
  const bounds = rotatedMediaBounds(input.rect);
  return {
    dx: constrainAxis({
      proposed: input.proposed.dx,
      itemStart: bounds.left,
      itemEnd: bounds.right,
      canvasStart: input.canvas.left,
      canvasEnd: input.canvas.right,
    }),
    dy: constrainAxis({
      proposed: input.proposed.dy,
      itemStart: bounds.top,
      itemEnd: bounds.bottom,
      canvasStart: input.canvas.top,
      canvasEnd: input.canvas.bottom,
    }),
  };
}

function positiveAttribute(element: Element, name: string): number | null {
  const value = Number.parseFloat(element.getAttribute(name) ?? "");
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Clamp one numeric X/Y inspector edit using the media's currently painted
 * bounds. Values remain in composition units; DOM rectangles are used only as
 * the measured bridge so canvas zoom cannot change the persisted coordinate.
 */
export function constrainMediaPositionAxisValue(input: {
  element: HTMLElement;
  axis: "x" | "y";
  current: number;
  proposed: number;
}): number {
  if (!isCanvasBoundMediaElement(input.element)) return input.proposed;
  const root = input.element.closest<HTMLElement>("[data-composition-id]");
  if (!root || root === input.element) return input.proposed;
  const mediaRect = input.element.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  if (
    mediaRect.width <= 0 ||
    mediaRect.height <= 0 ||
    rootRect.width <= 0 ||
    rootRect.height <= 0 ||
    !Number.isFinite(input.current) ||
    !Number.isFinite(input.proposed)
  ) {
    return input.proposed;
  }
  const declaredWidth = positiveAttribute(root, "data-width") ?? rootRect.width;
  const declaredHeight = positiveAttribute(root, "data-height") ?? rootRect.height;
  const unitScaleX = rootRect.width / declaredWidth;
  const unitScaleY = rootRect.height / declaredHeight;
  const visibleRect = hugOrientedRectForElement(
    {
      left: mediaRect.left,
      top: mediaRect.top,
      width: mediaRect.width,
      height: mediaRect.height,
      editScaleX: unitScaleX,
      editScaleY: unitScaleY,
      // The helper recovers an oriented frame from the element transform when
      // available; this BCR is the safe axis-aligned fallback.
      angle: 0,
    },
    input.element,
  );
  const propertyDelta = input.proposed - input.current;
  const contained = constrainMediaDragDelta({
    rect: visibleRect,
    canvas: {
      left: rootRect.left,
      top: rootRect.top,
      right: rootRect.right,
      bottom: rootRect.bottom,
    },
    proposed: {
      dx: input.axis === "x" ? propertyDelta * unitScaleX : 0,
      dy: input.axis === "y" ? propertyDelta * unitScaleY : 0,
    },
  });
  const appliedPixels = input.axis === "x" ? contained.dx : contained.dy;
  const unitScale = input.axis === "x" ? unitScaleX : unitScaleY;
  return input.current + appliedPixels / unitScale;
}

export function constrainMediaGroupDragDelta(input: {
  rects: readonly MediaRect[];
  canvas: CanvasEdges;
  proposed: { dx: number; dy: number };
}): { dx: number; dy: number } {
  if (input.rects.length === 0) return input.proposed;
  const bounds = input.rects.map(rotatedMediaBounds);
  return {
    dx: constrainAxis({
      proposed: input.proposed.dx,
      itemStart: Math.min(...bounds.map((item) => item.left)),
      itemEnd: Math.max(...bounds.map((item) => item.right)),
      canvasStart: input.canvas.left,
      canvasEnd: input.canvas.right,
    }),
    dy: constrainAxis({
      proposed: input.proposed.dy,
      itemStart: Math.min(...bounds.map((item) => item.top)),
      itemEnd: Math.max(...bounds.map((item) => item.bottom)),
      canvasStart: input.canvas.top,
      canvasEnd: input.canvas.bottom,
    }),
  };
}

/**
 * Cap a proportional, center-anchored resize so the media's rotated painted
 * box remains inside the composition. The returned dimensions preserve the
 * caller's aspect ratio because one uniform factor is applied to both axes.
 */
export function constrainMediaResizeSize(input: {
  desired: { width: number; height: number };
  center: { x: number; y: number };
  angle: number;
  displayScaleX: number;
  displayScaleY: number;
  canvas: CanvasEdges;
}): { width: number; height: number } {
  const width = Math.max(0, finiteOr(input.desired.width, 0));
  const height = Math.max(0, finiteOr(input.desired.height, 0));
  if (width === 0 || height === 0) return { width, height };

  const radians = (finiteOr(input.angle, 0) * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const displayedWidth = width * Math.abs(finiteOr(input.displayScaleX, 1));
  const displayedHeight = height * Math.abs(finiteOr(input.displayScaleY, 1));
  const halfPaintedWidth = (displayedWidth * cosine + displayedHeight * sine) / 2;
  const halfPaintedHeight = (displayedWidth * sine + displayedHeight * cosine) / 2;
  const availableHalfWidth = Math.max(
    0,
    Math.min(input.center.x - input.canvas.left, input.canvas.right - input.center.x),
  );
  const availableHalfHeight = Math.max(
    0,
    Math.min(input.center.y - input.canvas.top, input.canvas.bottom - input.center.y),
  );
  const factor = Math.max(
    0,
    Math.min(
      1,
      halfPaintedWidth > 0 ? availableHalfWidth / halfPaintedWidth : 1,
      halfPaintedHeight > 0 ? availableHalfHeight / halfPaintedHeight : 1,
    ),
  );
  return { width: width * factor, height: height * factor };
}
