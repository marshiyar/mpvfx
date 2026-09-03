const STRIP_COLORS = [
  { fill: "rgba(60, 230, 172, 0.22)", edge: "#3CE6AC" },
  { fill: "rgba(91, 166, 255, 0.22)", edge: "#5BA6FF" },
  { fill: "rgba(190, 119, 255, 0.22)", edge: "#BE77FF" },
  { fill: "rgba(255, 176, 77, 0.22)", edge: "#FFB04D" },
  { fill: "rgba(255, 103, 153, 0.22)", edge: "#FF6799" },
] as const;

/** Stable color for an attached timeline strip, independent of selection. */
export function timelineNestedStripColor(key: string): (typeof STRIP_COLORS)[number] {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return STRIP_COLORS[hash % STRIP_COLORS.length] ?? STRIP_COLORS[0];
}

/** CSS-safe stable suffix for a peer clip's strip region. */
export function timelineNestedStripIdToken(key: string): string {
  let hash = 2166136261;
  for (const character of key) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
