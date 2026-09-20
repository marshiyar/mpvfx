const ABSOLUTE_OR_ROOT_SOURCE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;

function parseSerializedColorGrading(value: string): { lut?: { src?: unknown } } | null {
  try {
    return JSON.parse(value) as { lut?: { src?: unknown } } | null;
  } catch {
    return null;
  }
}

function readLutSource(value: string | null): string {
  const src = value ? parseSerializedColorGrading(value)?.lut?.src : null;
  return typeof src === "string" ? src.trim() : "";
}

export function hasRelativeLutSource(value: string | null): boolean {
  const src = readLutSource(value);
  return src !== "" && !ABSOLUTE_OR_ROOT_SOURCE_RE.test(src);
}
