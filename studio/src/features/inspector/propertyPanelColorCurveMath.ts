import {
  compileHfColorCurve,
  compileHfHueCurve,
  HF_COLOR_CURVE_MAX_POINTS,
  type HfColorCurvePoint,
  type HfColorGradingCurveKey,
  type HfColorGradingHueCurveKey,
  type HfHueCurvePoint,
  type NormalizedHfColorGradingCurves,
  type NormalizedHfColorGradingHueCurves,
} from "@hyperframes/core/color-grading";
import { clampNumber } from "../../lib/studioHelpers";

export const GRAPH_SIZE = 160;
export const GRAPH_PADDING = 8;
const SAMPLE_COUNT = 128;
// Keep editable nodes far enough apart to pick individually at the graph's
// actual drawing size. Existing project points are left intact until edited.
const POINT_PICK_PX = 12;
const POINT_INPUT_PICK_PX = 8;
const POINT_INPUT_GAP_PX = 6;
const GRAPH_INNER_SIZE = GRAPH_SIZE - GRAPH_PADDING * 2;

type RgbTab = {
  kind: "rgb";
  key: HfColorGradingCurveKey;
  label: string;
  color: string;
  min: 0;
  max: 1;
};
type HueTab = {
  kind: "hue";
  key: HfColorGradingHueCurveKey;
  label: string;
  color: string;
  min: number;
  max: number;
};
export type CurveTab = RgbTab | HueTab;

export const TABS: readonly CurveTab[] = [
  { kind: "rgb", key: "master", label: "Master", color: "#e5e7eb", min: 0, max: 1 },
  { kind: "rgb", key: "red", label: "R", color: "#fb7185", min: 0, max: 1 },
  { kind: "rgb", key: "green", label: "G", color: "#4ade80", min: 0, max: 1 },
  { kind: "rgb", key: "blue", label: "B", color: "#60a5fa", min: 0, max: 1 },
  { kind: "hue", key: "hueVsHue", label: "Hue/Hue", color: "#f0abfc", min: -180, max: 180 },
  { kind: "hue", key: "hueVsSaturation", label: "Hue/Sat", color: "#facc15", min: -1, max: 1 },
  { kind: "hue", key: "hueVsLuma", label: "Hue/Luma", color: "#f8fafc", min: -1, max: 1 },
];

export const RGB_IDENTITY: readonly HfColorCurvePoint[] = [
  [0, 0],
  [1, 1],
];

export interface ColorCurveValues {
  curves: NormalizedHfColorGradingCurves;
  hueCurves: NormalizedHfColorGradingHueCurves;
}

export function graphPoint(input: number, output: number, tab: CurveTab) {
  const inner = GRAPH_SIZE - GRAPH_PADDING * 2;
  const xRatio = tab.kind === "rgb" ? input : input / 360;
  const yRatio = (output - tab.min) / (tab.max - tab.min);
  return {
    x: GRAPH_PADDING + xRatio * inner,
    y: GRAPH_SIZE - GRAPH_PADDING - yRatio * inner,
  };
}

export type CurvePointerRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

export function snapshotPointerRect(rect: DOMRect): CurvePointerRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function valueFromPointer(
  clientX: number,
  clientY: number,
  rect: CurvePointerRect,
  tab: CurveTab,
) {
  const inner = GRAPH_SIZE - GRAPH_PADDING * 2;
  const graphX = ((clientX - rect.left) / Math.max(rect.width, 1)) * GRAPH_SIZE;
  const graphY = ((clientY - rect.top) / Math.max(rect.height, 1)) * GRAPH_SIZE;
  const xRatio = clampNumber((graphX - GRAPH_PADDING) / inner, 0, 1);
  const yRatio = 1 - clampNumber((graphY - GRAPH_PADDING) / inner, 0, 1);
  return {
    input: tab.kind === "rgb" ? xRatio : Math.min(359.999, xRatio * 360),
    output: tab.min + yRatio * (tab.max - tab.min),
  };
}

export function curvePath(samples: Float32Array, tab: CurveTab): string {
  return [...samples]
    .map((sample, index) => {
      const input =
        tab.kind === "rgb" ? index / (samples.length - 1) : (index / samples.length) * 360;
      const point = graphPoint(input, sample, tab);
      return `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    })
    .join(" ");
}

export function samplesFor(points: readonly (HfColorCurvePoint | HfHueCurvePoint)[], tab: CurveTab) {
  if (tab.kind === "rgb") {
    return compileHfColorCurve(points as readonly HfColorCurvePoint[], SAMPLE_COUNT);
  }
  if (points.length < 3) return new Float32Array(SAMPLE_COUNT);
  return compileHfHueCurve(points as readonly HfHueCurvePoint[], tab.min, tab.max, SAMPLE_COUNT);
}

export function pointsFor(value: ColorCurveValues, tab: CurveTab) {
  return tab.kind === "rgb" ? value.curves[tab.key] : value.hueCurves[tab.key];
}

function circularHueDistance(left: number, right: number): number {
  const distance = Math.abs(left - right) % 360;
  return Math.min(distance, 360 - distance);
}

export function withPoints(
  value: ColorCurveValues,
  tab: CurveTab,
  points: readonly (HfColorCurvePoint | HfHueCurvePoint)[],
): ColorCurveValues {
  return tab.kind === "rgb"
    ? {
        ...value,
        curves: {
          ...value.curves,
          [tab.key]: points as readonly HfColorCurvePoint[],
        },
      }
    : {
        ...value,
        hueCurves: {
          ...value.hueCurves,
          [tab.key]: points as readonly HfHueCurvePoint[],
        },
      };
}

export function nearestInputPointIndex(
  points: readonly (HfColorCurvePoint | HfHueCurvePoint)[],
  input: number,
  tab: CurveTab,
  radiusPx = POINT_INPUT_PICK_PX,
): number {
  const inputSpan = tab.kind === "rgb" ? 1 : 360;
  let closest = -1;
  let distance = radiusPx / GRAPH_INNER_SIZE;
  points.forEach((point, index) => {
    const nextDistance =
      (tab.kind === "hue" ? circularHueDistance(point[0], input) : Math.abs(point[0] - input)) /
      inputSpan;
    if (nextDistance < distance) {
      closest = index;
      distance = nextDistance;
    }
  });
  return closest;
}

export function nearestGraphPointIndex(
  points: readonly (HfColorCurvePoint | HfHueCurvePoint)[],
  input: number,
  output: number,
  tab: CurveTab,
): number {
  const target = graphPoint(input, output, tab);
  let closest = -1;
  let distance = POINT_PICK_PX;
  points.forEach((point, index) => {
    const candidate = graphPoint(point[0], point[1], tab);
    const xDistance =
      tab.kind === "hue"
        ? (circularHueDistance(point[0], input) / 360) * (GRAPH_SIZE - GRAPH_PADDING * 2)
        : candidate.x - target.x;
    const nextDistance = Math.hypot(xDistance, candidate.y - target.y);
    if (nextDistance < distance) {
      closest = index;
      distance = nextDistance;
    }
  });
  return closest;
}

export function insertPoint(
  points: readonly (HfColorCurvePoint | HfHueCurvePoint)[],
  input: number,
  output: number,
  tab: CurveTab,
) {
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const existing = nearestInputPointIndex(points, input, tab);
  if (existing >= 0) return { points: [...points], selected: existing };
  if (points.length >= HF_COLOR_CURVE_MAX_POINTS) return null;
  if (tab.kind === "hue" && points.length < 3) {
    const result: HfHueCurvePoint[] = [
      [((input + 240) % 360) as number, 0],
      [input, output],
      [((input + 120) % 360) as number, 0],
    ];
    result.sort((a, b) => a[0] - b[0]);
    return { points: result, selected: result.findIndex((point) => point[0] === input) };
  }
  const next = [...points];
  const point =
    tab.kind === "rgb"
      ? ([input, clampNumber(output, 0, 1)] as HfColorCurvePoint)
      : ([input, clampNumber(output, tab.min, tab.max)] as HfHueCurvePoint);
  next.push(point);
  next.sort((a, b) => a[0] - b[0]);
  return { points: next, selected: next.indexOf(point) };
}

function safeRgbInput(
  points: readonly (HfColorCurvePoint | HfHueCurvePoint)[],
  index: number,
  input: number,
): number {
  if (index === 0) return 0;
  if (index === points.length - 1) return 1;
  const previous = points[index - 1]?.[0] ?? 0;
  const following = points[index + 1]?.[0] ?? 1;
  // Older projects may already contain tightly packed nodes. Allow editing
  // those without rewriting their neighbors or inverting the clamp interval.
  const gap = Math.min(POINT_INPUT_GAP_PX / GRAPH_INNER_SIZE, (following - previous) / 3);
  return clampNumber(
    input,
    previous + gap,
    following - gap,
  );
}

function safeHueInput(
  points: readonly (HfColorCurvePoint | HfHueCurvePoint)[],
  index: number,
  input: number,
): number {
  const current = points[index]?.[0] ?? 0;
  const previousPoint = points[(index - 1 + points.length) % points.length]?.[0] ?? current;
  const followingPoint = points[(index + 1) % points.length]?.[0] ?? current;
  const previous = previousPoint >= current ? previousPoint - 360 : previousPoint;
  const following = followingPoint <= current ? followingPoint + 360 : followingPoint;
  const gap = Math.min((POINT_INPUT_GAP_PX / GRAPH_INNER_SIZE) * 360, (following - previous) / 3);
  const initial = clampNumber(input, 0, 359.999);
  // Choose the same turn of the circular hue axis as the dragged node. A
  // point can pass through the red seam, but cannot leap over its neighbors.
  const unwrapped = initial + Math.round((current - initial) / 360) * 360;
  const safe = clampNumber(unwrapped, previous + gap, following - gap);
  return ((safe % 360) + 360) % 360;
}

export function movePoint(
  points: readonly (HfColorCurvePoint | HfHueCurvePoint)[],
  index: number,
  input: number,
  output: number,
  tab: CurveTab,
) {
  if (!Number.isFinite(input) || !Number.isFinite(output) || !points[index]) {
    return { points: [...points], selected: index };
  }
  const next = [...points];
  const safeInput =
    tab.kind === "rgb" ? safeRgbInput(next, index, input) : safeHueInput(next, index, input);
  const moved =
    tab.kind === "rgb"
      ? ([safeInput, clampNumber(output, 0, 1)] as HfColorCurvePoint)
      : ([safeInput, clampNumber(output, tab.min, tab.max)] as HfHueCurvePoint);
  next[index] = moved;
  next.sort((a, b) => a[0] - b[0]);
  return { points: next, selected: next.indexOf(moved) };
}

const ARROW_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;
export type ArrowKey = (typeof ARROW_KEYS)[number];

export function isArrowKey(key: string): key is ArrowKey {
  return ARROW_KEYS.includes(key as ArrowKey);
}

function curveOutputStep(tab: CurveTab, large: boolean): number {
  if (tab.kind === "rgb") return large ? 0.05 : 0.01;
  if (tab.key === "hueVsHue") return large ? 10 : 1;
  return large ? 0.1 : 0.01;
}

export function keyboardPointPosition(
  point: HfColorCurvePoint | HfHueCurvePoint,
  key: ArrowKey,
  tab: CurveTab,
  large: boolean,
) {
  const inputStep = tab.kind === "rgb" ? (large ? 0.05 : 0.01) : large ? 10 : 1;
  const outputStep = curveOutputStep(tab, large);
  const inputDelta = key === "ArrowLeft" ? -inputStep : key === "ArrowRight" ? inputStep : 0;
  const outputDelta = key === "ArrowDown" ? -outputStep : key === "ArrowUp" ? outputStep : 0;
  return { input: point[0] + inputDelta, output: point[1] + outputDelta };
}

export function formatPointValue(value: number, tab: CurveTab, axis: "input" | "output") {
  if (tab.kind === "hue" && axis === "input") return Number(value.toFixed(1));
  if (tab.kind === "rgb") return Number(value.toFixed(3));
  return Number(value.toFixed(tab.key === "hueVsHue" ? 1 : 3));
}
