import { previewOriginForProject } from "../../../shared/desktopPreviewOrigin";

/** Keep authored documents on the project preview origin in the desktop app. */
export function resolvePreviewUrl(
  projectId: string,
  path: string,
  editorOrigin: string,
): string {
  const url = new URL(path, editorOrigin);
  if (!editorOrigin.startsWith("mpvfx://")) return url.toString();
  if (url.protocol !== "mpvfx:" || url.host !== new URL(editorOrigin).host) {
    throw new Error("Preview URL must use the editor origin before isolation");
  }
  const prefix = `/api/projects/${encodeURIComponent(projectId)}/preview`;
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    throw new Error("Preview URL must belong to the active project");
  }
  return `${previewOriginForProject(projectId)}${url.pathname}${url.search}${url.hash}`;
}

export function previewOriginFromIframe(
  iframe: HTMLIFrameElement,
): string | null {
  try {
    const url = new URL(iframe.src);
    return url.protocol === "mpvfx:" ? `mpvfx://${url.host}` : url.origin;
  } catch {
    return null;
  }
}

export function isExpectedPreviewMessage(
  event: MessageEvent,
  iframe: HTMLIFrameElement | null,
): boolean {
  if (!iframe || event.source !== iframe.contentWindow) return false;
  const expectedOrigin = previewOriginFromIframe(iframe);
  return expectedOrigin !== null && event.origin === expectedOrigin;
}
