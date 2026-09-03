import type { NativeEditableProperty } from "./nativePropertyEditPlan";

export type NativePropertyBaselines = Partial<Record<NativeEditableProperty, number>>;

export interface NativePropertyBaselineSource {
  readonly computedStyles?: Readonly<Record<string, string>>;
  readonly boundingBox: { readonly width: number; readonly height: number };
}

const finite = (value: number): number | undefined => (Number.isFinite(value) ? value : undefined);

const positiveCssNumber = (value: string | undefined): number | undefined => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const finiteCssNumber = (value: string | undefined): number | undefined => {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
};

const angleDegrees = (value: string | undefined): number | undefined => {
  if (!value || value.trim().toLowerCase() === "none") return undefined;
  const token = value.trim().split(/\s+/).at(-1)?.toLowerCase();
  if (!token) return undefined;
  const numeric = Number.parseFloat(token);
  if (!Number.isFinite(numeric)) return undefined;
  if (token.endsWith("deg")) return numeric;
  if (token.endsWith("rad")) return (numeric * 180) / Math.PI;
  if (token.endsWith("turn")) return numeric * 360;
  if (token.endsWith("grad")) return numeric * 0.9;
  return numeric === 0 ? 0 : undefined;
};

const individualTransformBaselines = (
  styles: Readonly<Record<string, string>>,
): NativePropertyBaselines => {
  const result: NativePropertyBaselines = {};
  const translate = styles.translate?.trim().split(/\s+/) ?? [];
  if (translate.length > 0 && translate[0]?.toLowerCase() !== "none") {
    const x = finiteCssNumber(translate[0]);
    const y = finiteCssNumber(translate[1]) ?? 0;
    if (x !== undefined) result.x = x;
    if (x !== undefined && y !== undefined) result.y = y;
  }
  const rotation = angleDegrees(styles.rotate);
  if (rotation !== undefined) {
    result.rotation = rotation;
    result.rotationZ = rotation;
  }
  const scale = styles.scale?.trim().split(/\s+/) ?? [];
  if (scale.length > 0 && scale[0]?.toLowerCase() !== "none") {
    const x = finiteCssNumber(scale[0]);
    const y = finiteCssNumber(scale[1]) ?? x;
    if (x !== undefined) result.scaleX = x;
    if (y !== undefined) result.scaleY = y;
    if (x !== undefined && y !== undefined && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y))) {
      result.scale = (x + y) / 2;
    }
  }
  return result;
};

const matrixNumbers = (transform: string | undefined): number[] | null => {
  if (!transform || transform.trim().toLowerCase() === "none") return null;
  const match = transform.trim().match(/^matrix(3d)?\((.*)\)$/i);
  if (!match) return null;
  const values = match[2]!.split(",").map((part) => Number(part.trim()));
  const expected = match[1] ? 16 : 6;
  return values.length === expected && values.every(Number.isFinite) ? values : null;
};

const transformBaselines = (transform: string | undefined): NativePropertyBaselines => {
  const values = matrixNumbers(transform);
  if (!values) return {};
  const is3d = values.length === 16;
  const a = values[0]!;
  const b = values[1]!;
  const c = values[is3d ? 4 : 2]!;
  const d = values[is3d ? 5 : 3]!;
  const x = values[is3d ? 12 : 4]!;
  const y = values[is3d ? 13 : 5]!;
  const scaleX = Math.hypot(a, b, ...(is3d ? [values[2]!] : []));
  const rawScaleY = Math.hypot(c, d, ...(is3d ? [values[6]!] : []));
  const determinant2d = a * d - b * c;
  const scaleY = determinant2d < 0 ? -rawScaleY : rawScaleY;
  const rotation = (Math.atan2(b, a) * 180) / Math.PI;
  const result: NativePropertyBaselines = {
    x,
    y,
    rotation,
    rotationZ: rotation,
    scaleX,
    scaleY,
  };
  if (Math.abs(scaleX - scaleY) <= 1e-9 * Math.max(1, scaleX, Math.abs(scaleY))) {
    result.scale = (scaleX + scaleY) / 2;
  }
  return result;
};

/** Snapshot pre-native visual values so the first keyframe cannot jump to identity. */
export function readNativePropertyBaselines(
  source: NativePropertyBaselineSource,
): NativePropertyBaselines {
  const styles = source.computedStyles ?? {};
  const result = transformBaselines(styles.transform);
  const individual = individualTransformBaselines(styles);
  if (individual.x !== undefined) result.x = (result.x ?? 0) + individual.x;
  if (individual.y !== undefined) result.y = (result.y ?? 0) + individual.y;
  if (individual.rotation !== undefined) {
    result.rotation = (result.rotation ?? 0) + individual.rotation;
    result.rotationZ = result.rotation;
  }
  if (individual.scaleX !== undefined) {
    result.scaleX = (result.scaleX ?? 1) * individual.scaleX;
  }
  if (individual.scaleY !== undefined) {
    result.scaleY = (result.scaleY ?? 1) * individual.scaleY;
  }
  if (result.scaleX !== undefined && result.scaleY !== undefined) {
    result.scale =
      Math.abs(result.scaleX - result.scaleY) <=
      1e-9 * Math.max(1, Math.abs(result.scaleX), Math.abs(result.scaleY))
        ? (result.scaleX + result.scaleY) / 2
        : undefined;
  }
  const opacity = finite(Number.parseFloat(styles.opacity ?? ""));
  if (opacity !== undefined) {
    result.opacity = Math.max(0, Math.min(1, opacity));
    result.autoAlpha = result.opacity;
  }
  const width = positiveCssNumber(styles.width) ??
    (Number.isFinite(source.boundingBox.width) && source.boundingBox.width > 0
      ? source.boundingBox.width
      : undefined);
  const height = positiveCssNumber(styles.height) ??
    (Number.isFinite(source.boundingBox.height) && source.boundingBox.height > 0
      ? source.boundingBox.height
      : undefined);
  if (width !== undefined) result.width = width;
  if (height !== undefined) result.height = height;
  return result;
}
