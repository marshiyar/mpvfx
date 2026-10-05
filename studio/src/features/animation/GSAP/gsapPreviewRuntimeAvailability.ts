/**
 * Legacy GSAP edits need a live tween/element observation before writing source.
 * A null iframe preserves the established no-preview source-only route; a
 * mounted but inaccessible frame is an isolated preview and cannot supply that
 * observation through its WindowProxy.
 */
export function isPreviewRuntimeInaccessible(iframe: HTMLIFrameElement | null): boolean {
  if (!iframe) return false;
  try {
    return iframe.contentDocument === null;
  } catch {
    return true;
  }
}
