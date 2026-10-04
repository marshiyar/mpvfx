/** Encode a filesystem path exactly once, at the URL boundary. */
export function encodeMediaPath(path: string): string {
  return path.split("/").map(part => encodeURIComponent(part).replace(/'/g, "%27")).join("/");
}

export function projectMediaUrl(projectId: string, path: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/preview/${encodeMediaPath(path)}`;
}
