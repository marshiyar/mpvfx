import type { NativeInterpolation } from "./nativeKeyframeTypes";

type Point = { x: number; y: number };
type Curve = [Point, Point, Point, Point];
const mix = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

function split(curve: Curve, t: number): [Curve, Curve] {
  const a = mix(curve[0], curve[1], t);
  const b = mix(curve[1], curve[2], t);
  const c = mix(curve[2], curve[3], t);
  const d = mix(a, b, t);
  const e = mix(b, c, t);
  const f = mix(d, e, t);
  return [
    [curve[0], a, d, f],
    [f, e, c, curve[3]],
  ];
}

function parameterAtX(curve: Curve, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i++) {
    const t = (lo + hi) / 2;
    if (split(curve, t)[0][3].x < x) lo = t;
    else hi = t;
  }
  return (lo + hi) / 2;
}

/** Restrict a timing curve to a time interval without restarting its easing.
 * A returning curve with equal endpoint values cannot be encoded as one
 * normalized segment; the caller must retain frame samples for that case. */
export function sliceNativeInterpolation(
  interpolation: NativeInterpolation,
  from: number,
  to: number,
): NativeInterpolation | null {
  if (interpolation.type !== "cubic-bezier") return { ...interpolation };
  if (from === 0 && to === 1) {
    return {
      ...interpolation,
      controlPoints: { ...interpolation.controlPoints },
    };
  }
  const { x1, y1, x2, y2 } = interpolation.controlPoints;
  const original: Curve = [
    { x: 0, y: 0 },
    { x: x1, y: y1 },
    { x: x2, y: y2 },
    { x: 1, y: 1 },
  ];
  const a = parameterAtX(original, from);
  const b = parameterAtX(original, to);
  const left = split(original, b)[0];
  const curve = split(left, b > 0 ? a / b : 0)[1];
  const dx = curve[3].x - curve[0].x;
  const dy = curve[3].y - curve[0].y;
  if (Math.abs(dy) < 1e-12 || dx <= 0) return null;
  const normalizeX = (x: number) =>
    Math.min(1, Math.max(0, (x - curve[0].x) / dx));
  return {
    type: "cubic-bezier",
    controlPoints: {
      x1: normalizeX(curve[1].x),
      y1: (curve[1].y - curve[0].y) / dy,
      x2: normalizeX(curve[2].x),
      y2: (curve[2].y - curve[0].y) / dy,
    },
  };
}
