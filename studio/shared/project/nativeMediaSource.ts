import type { NativeProjectAssetKind } from "./nativeProjectDocument";

/**
 * Canonical project-owned source. Transport URLs are decoded once; plain paths
 * retain literal percent, query, and fragment characters in their filenames.
 * This is lexical identity, not a filesystem fingerprint or a symlink check.
 */
export function nativeMediaSource(source: string, projectId: string): string | null {
  let path = source;
  if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("/api/")) {
    const match = /^(?:mpvfx:\/\/editor)?\/api\/projects\/([^/]+)\/preview\/([^?#]+)(?:[?#].*)?$/.exec(source);
    if (!match) return null;
    try {
      if (decodeURIComponent(match[1]) !== projectId) return null;
      path = decodeURIComponent(match[2]);
    } catch { return null; }
  }
  path = path.replace(/\\/g, "/");
  const parts = path.split("/");
  if (!path || path.startsWith("/") || path.includes("\0") || parts.includes("..") || !parts.at(-1) || parts.at(-1) === ".") return null;
  const canonical = parts.filter(part => part !== "" && part !== ".").join("/");
  if (!canonical || /^[a-z][a-z\d+.-]*:/i.test(canonical)) return null;
  return canonical;
}

/** Only for new assets; an existing asset keeps its persisted ID on reuse. */
export function nativeMediaAssetId(kind: NativeProjectAssetKind, canonicalSource: string): string {
  return `native-asset:${kind}:${canonicalSource.length}:${canonicalSource}`;
}
