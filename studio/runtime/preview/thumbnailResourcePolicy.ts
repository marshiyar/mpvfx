import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SHARED_PREVIEW_RESOURCES = new Set([
  "/api/runtime.js",
  "/api/motion-path-plugin.js",
  "/api/fonts/file",
]);

function projectIdFromPreview(url: URL): string | null {
  const match = /^\/api\/projects\/([^/]+)\/preview(?:\/|$)/.exec(url.pathname);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id && id !== "." && id !== ".." && !/[/\\\x00-\x1f]/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The thumbnail browser may read only the composition it is capturing. */
export function thumbnailMayReadResource(previewUrl: string, request: Request, projectDir: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let preview: URL;
  let resource: URL;
  try {
    preview = new URL(previewUrl);
    resource = new URL(request.url);
  } catch {
    return false;
  }
  if (resource.origin !== "https://mpvfx.invalid" || /%(?:2f|5c|00)/i.test(resource.pathname)) {
    return false;
  }
  if (SHARED_PREVIEW_RESOURCES.has(resource.pathname)) return true;
  const currentId = projectIdFromPreview(preview);
  if (currentId === null || projectIdFromPreview(resource) !== currentId) return false;
  const prefix = /^\/api\/projects\/[^/]+\/preview(?:\/|$)/.exec(resource.pathname)?.[0];
  if (!prefix) return false;
  const encoded = resource.pathname.slice(prefix.length);
  let segments: string[];
  try {
    segments = encoded.split("/").map(segment => decodeURIComponent(segment));
  } catch {
    return false;
  }
  if (segments.some(segment => segment.startsWith(".") || /[\\/\x00-\x1f]/.test(segment) ||
    /%(?:2e|2f|5c|00)/i.test(segment))) return false;
  // The composition endpoint maps /preview/comp/<file> to <file> in the
  // project. The plain preview endpoint maps to index.html.
  const fileSegments = segments[0] === "comp" ? segments.slice(1) : segments;
  const candidate = resolve(projectDir, ...(fileSegments.some(Boolean) ? fileSegments : ["index.html"]));
  try {
    const root = realpathSync(projectDir);
    const file = realpathSync(candidate);
    const path = relative(root, file);
    return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  } catch {
    return false;
  }
}
