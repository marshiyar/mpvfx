/** Match the standalone route without intercepting the shared render API. */
export function matchRenderHeartbeatRequest(method: string | undefined, pathname: string): string | null {
  if (method !== "POST") return null;
  const match = pathname.match(/^\/render\/([^/]+)\/heartbeat$/);
  if (!match) return null;
  try {
    const jobId = decodeURIComponent(match[1]);
    return jobId.length > 0 ? jobId : null;
  } catch {
    return null;
  }
}
