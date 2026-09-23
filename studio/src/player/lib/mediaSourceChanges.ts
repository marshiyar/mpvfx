import { nativeMediaSource } from "../../../shared/project/nativeMediaSource";
import { resolveMediaPreviewUrl } from "../components/thumbnailUtils";

/** Match a source to a project file without interpreting labels or foreign URLs. */
export function projectMediaSourcePath(source: string, projectId: string): string | null {
  if (!/^[a-z][a-z\d+.-]*:/i.test(source)) {
    const direct = nativeMediaSource(source, projectId);
    if (direct || source.startsWith("/api/")) return direct;
  }
  const resolved = resolveMediaPreviewUrl(source, projectId, window.location.href);
  try {
    const url = new URL(resolved, window.location.href);
    const origin = new URL(window.location.href);
    if (url.protocol !== origin.protocol || url.host !== origin.host) return null;
    return nativeMediaSource(`${url.pathname}${url.search}${url.hash}`, projectId);
  } catch {
    return null;
  }
}

type Listener = { projectId: string; source: string; notify: () => void };
const listeners = new Set<Listener>();

export function subscribeMediaSourceChange(
  projectId: string,
  source: string,
  notify: () => void,
): () => void {
  const listener = { projectId, source, notify };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyMediaSourceChange(projectId: string, path: string): void {
  for (const listener of [...listeners]) {
    if (
      listener.projectId === projectId &&
      projectMediaSourcePath(listener.source, projectId) === path
    ) {
      listener.notify();
    }
  }
}

/** Transport revision only; the underlying source identity remains unchanged. */
export function revisionedMediaUrl(source: string, revision: string | number | undefined): string {
  if (revision === undefined || revision === 0) return source;
  const url = new URL(source, window.location.href);
  url.searchParams.set("_mpvfx_media", String(revision));
  return url.href;
}
