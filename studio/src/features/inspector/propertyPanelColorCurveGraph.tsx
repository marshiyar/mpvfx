import { useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { HfColorCurvePoint, HfHueCurvePoint } from "@hyperframes/core/color-grading";
import {
  GRAPH_SIZE,
  GRAPH_PADDING,
  graphPoint,
  snapshotPointerRect,
  valueFromPointer,
  curvePath,
  samplesFor,
  nearestInputPointIndex,
  nearestGraphPointIndex,
  insertPoint,
  isArrowKey,
  keyboardPointPosition,
  movePoint,
  type ArrowKey,
  type CurvePointerRect,
  type CurveTab,
} from "./propertyPanelColorCurveMath";
export {
  TABS,
  RGB_IDENTITY,
  pointsFor,
  withPoints,
  movePoint,
  formatPointValue,
} from "./propertyPanelColorCurveMath";
export type { ColorCurveValues, CurveTab } from "./propertyPanelColorCurveMath";

export function CurveGraph({
  tab,
  points,
  selectedIndex,
  disabled,
  onBegin,
  onPreview,
  onSelect,
  onDelete,
  onSettle,
  onCancel,
}: {
  tab: CurveTab;
  points: readonly (HfColorCurvePoint | HfHueCurvePoint)[];
  selectedIndex: number | null;
  disabled?: boolean;
  onBegin: () => void;
  onPreview: (
    points: readonly (HfColorCurvePoint | HfHueCurvePoint)[],
    selectedIndex: number,
  ) => void;
  onSelect: (index: number | null) => void;
  onDelete: () => void;
  onSettle: () => void;
  onCancel: () => void;
}) {
  const pointerRef = useRef<{
    pointerId: number;
    index: number;
    points: readonly (HfColorCurvePoint | HfHueCurvePoint)[];
    rect: CurvePointerRect;
    startX: number;
    startY: number;
    changed: boolean;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const samples = useMemo(() => samplesFor(points, tab), [points, tab]);
  const path = useMemo(() => curvePath(samples, tab), [samples, tab]);
  const selectRelativePoint = (offset: number) => {
    if (points.length === 0) return;
    const current = selectedIndex ?? (offset > 0 ? -1 : 0);
    onSelect((current + offset + points.length) % points.length);
  };
  const addKeyboardPoint = () => {
    const input = tab.kind === "rgb" ? 0.5 : 180;
    const existing = nearestInputPointIndex(points, input, tab);
    if (existing >= 0) {
      onSelect(existing);
      return;
    }
    const output =
      tab.kind === "rgb"
        ? ((samples[Math.floor((samples.length - 1) / 2)] ?? input) +
            (samples[Math.ceil((samples.length - 1) / 2)] ?? input)) /
          2
        : (samples[Math.round(samples.length / 2)] ?? 0);
    const inserted = insertPoint(points, input, output, tab);
    if (!inserted) return;
    onBegin();
    onPreview(inserted.points, inserted.selected);
    onSettle();
  };
  const moveSelectedByKeyboard = (key: ArrowKey, large: boolean) => {
    if (selectedIndex === null) return false;
    const selected = points[selectedIndex];
    if (!selected) return false;
    const position = keyboardPointPosition(selected, key, tab, large);
    const moved = movePoint(points, selectedIndex, position.input, position.output, tab);
    onBegin();
    onPreview(moved.points, moved.selected);
    return true;
  };

  const previewFromPointer = (clientX: number, clientY: number) => {
    const active = pointerRef.current;
    if (!active) return;
    if (!active.changed && Math.hypot(clientX - active.startX, clientY - active.startY) < 2) return;
    const nextValue = valueFromPointer(
      clientX - active.offsetX,
      clientY - active.offsetY,
      active.rect,
      tab,
    );
    const moved = movePoint(active.points, active.index, nextValue.input, nextValue.output, tab);
    pointerRef.current = {
      pointerId: active.pointerId,
      index: moved.selected,
      points: moved.points,
      rect: active.rect,
      startX: active.startX,
      startY: active.startY,
      changed: true,
      offsetX: active.offsetX,
      offsetY: active.offsetY,
    };
    onPreview(moved.points, moved.selected);
  };
  const handleRemovalKey = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      pointerRef.current = null;
      onCancel();
      return true;
    }
    const deleteKey = event.key === "Delete" || event.key === "Backspace";
    if (deleteKey) {
      event.preventDefault();
      event.stopPropagation();
      if (selectedIndex !== null) onDelete();
      return true;
    }
    return false;
  };
  const handleAddKey = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      addKeyboardPoint();
      return true;
    }
    return false;
  };
  const handleSelectionKey = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      event.stopPropagation();
      selectRelativePoint(event.key === "PageUp" ? -1 : 1);
      return true;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      if (points.length === 0) return true;
      onSelect(event.key === "Home" ? 0 : points.length - 1);
      return true;
    }
    return false;
  };
  const handleArrowKey = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (!isArrowKey(event.key)) return false;
    event.preventDefault();
    event.stopPropagation();
    if (points.length === 0) return true;
    if (selectedIndex === null) {
      const selectLast = event.key === "ArrowLeft" || event.key === "ArrowDown";
      onSelect(selectLast ? points.length - 1 : 0);
      return true;
    }
    moveSelectedByKeyboard(event.key, event.shiftKey);
    return true;
  };
  const handleKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (handleRemovalKey(event)) return;
    if (handleAddKey(event)) return;
    if (handleSelectionKey(event)) return;
    handleArrowKey(event);
  };

  return (
    <svg
      viewBox={`0 0 ${GRAPH_SIZE} ${GRAPH_SIZE}`}
      role="application"
      aria-label={`${tab.label} curve`}
      aria-keyshortcuts="Enter Space ArrowLeft ArrowRight ArrowUp ArrowDown PageUp PageDown Home End Delete"
      tabIndex={disabled ? -1 : 0}
      data-color-curve-graph={tab.key}
      data-color-curve-mid-sample={(samples[Math.floor(samples.length / 2)] ?? 0).toFixed(5)}
      onPointerDown={(event) => {
        if (disabled) return;
        const rect = snapshotPointerRect(event.currentTarget.getBoundingClientRect());
        const value = valueFromPointer(
          event.clientX,
          event.clientY,
          rect,
          tab,
        );
        let index = nearestGraphPointIndex(points, value.input, value.output, tab);
        if (index < 0) index = nearestInputPointIndex(points, value.input, tab);
        let nextPoints = points;
        let insertedPoint = false;
        if (index < 0) {
          const inserted = insertPoint(points, value.input, value.output, tab);
          if (!inserted) return;
          nextPoints = inserted.points;
          index = inserted.selected;
          insertedPoint = true;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        const grabbedPoint = nextPoints[index];
        const drawn = grabbedPoint ? graphPoint(grabbedPoint[0], grabbedPoint[1], tab) : null;
        const offsetX = insertedPoint || !drawn
          ? 0
          : event.clientX - (rect.left + (drawn.x / GRAPH_SIZE) * rect.width);
        const offsetY = insertedPoint || !drawn
          ? 0
          : event.clientY - (rect.top + (drawn.y / GRAPH_SIZE) * rect.height);
        pointerRef.current = {
          pointerId: event.pointerId, index, points: nextPoints, rect,
          startX: event.clientX, startY: event.clientY, changed: false,
          offsetX, offsetY,
        };
        onBegin();
        onSelect(index);
        if (insertedPoint) onPreview(nextPoints, index);
      }}
      onPointerMove={(event) => {
        if (disabled || pointerRef.current?.pointerId !== event.pointerId) return;
        previewFromPointer(event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        if (pointerRef.current?.pointerId !== event.pointerId) return;
        if (pointerRef.current.changed) previewFromPointer(event.clientX, event.clientY);
        pointerRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        onSettle();
      }}
      onPointerCancel={() => {
        pointerRef.current = null;
        onCancel();
      }}
      onLostPointerCapture={(event) => {
        if (pointerRef.current?.pointerId !== event.pointerId) return;
        pointerRef.current = null;
        onCancel();
      }}
      onKeyDown={handleKeyDown}
      onKeyUp={(event) => {
        if (isArrowKey(event.key)) {
          event.stopPropagation();
          if (selectedIndex !== null) onSettle();
        }
      }}
      className="mx-auto aspect-square w-full max-w-[200px] touch-none rounded border border-panel-border-input bg-black/20 outline-none focus:outline focus:outline-1 focus:outline-panel-accent"
    >
      <defs>
        <linearGradient id={`hf-hue-axis-${tab.key}`}>
          <stop offset="0%" stopColor="#f33" />
          <stop offset="16.7%" stopColor="#ff3" />
          <stop offset="33.3%" stopColor="#3f3" />
          <stop offset="50%" stopColor="#3ff" />
          <stop offset="66.7%" stopColor="#33f" />
          <stop offset="83.3%" stopColor="#f3f" />
          <stop offset="100%" stopColor="#f33" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((ratio) => (
        <g key={ratio} stroke="rgba(255,255,255,0.08)" strokeWidth="0.5">
          <line
            x1={GRAPH_PADDING}
            y1={GRAPH_PADDING + ratio * (GRAPH_SIZE - GRAPH_PADDING * 2)}
            x2={GRAPH_SIZE - GRAPH_PADDING}
            y2={GRAPH_PADDING + ratio * (GRAPH_SIZE - GRAPH_PADDING * 2)}
          />
          <line
            x1={GRAPH_PADDING + ratio * (GRAPH_SIZE - GRAPH_PADDING * 2)}
            y1={GRAPH_PADDING}
            x2={GRAPH_PADDING + ratio * (GRAPH_SIZE - GRAPH_PADDING * 2)}
            y2={GRAPH_SIZE - GRAPH_PADDING}
          />
        </g>
      ))}
      {tab.kind === "hue" && (
        <line
          x1={GRAPH_PADDING}
          y1={GRAPH_SIZE - 3}
          x2={GRAPH_SIZE - GRAPH_PADDING}
          y2={GRAPH_SIZE - 3}
          stroke={`url(#hf-hue-axis-${tab.key})`}
          strokeWidth="3"
        />
      )}
      <path
        data-color-curve-path="true"
        d={path}
        fill="none"
        stroke={tab.color}
        strokeWidth="1.5"
      />
      {points.map(([input, output], index) => {
        const point = graphPoint(input, output, tab);
        return (
          <circle
            key={`${tab.key}-${index}`}
            data-color-curve-point={index}
            cx={point.x}
            cy={point.y}
            r={selectedIndex === index ? 3.5 : 2.5}
            fill={selectedIndex === index ? "#fff" : tab.color}
            stroke="#111"
            strokeWidth="1"
          />
        );
      })}
    </svg>
  );
}
