import { desktopRequest } from "../../lib/desktopClient";
import { DESKTOP_ORIGIN, type VideoFramesRequest, type VideoFramesResult } from "../../../shared/desktopBridge";
import { TIMELINE_VIEWPORT_BUDGETS, type TimelineViewportBudgets } from "./timelineViewportBudgets";
import type { ThumbnailLoadedResult } from "./thumbnailScheduler";

export interface VideoThumbnailDecodeRequest {
  source: string;
  projectId?: string;
  sourceStart?: number;
  sourceRangeDuration?: number;
  frameCount: number;
}

/** Request decoded images from the native engine; the UI only displays them. */
export async function decodeVideoThumbnail(
  request: VideoThumbnailDecodeRequest,
  signal: AbortSignal,
  budgets: Readonly<TimelineViewportBudgets> = TIMELINE_VIEWPORT_BUDGETS,
): Promise<ThumbnailLoadedResult & { duration?: number }> {
  signal.throwIfAborted();
  const url = new URL(request.source, DESKTOP_ORIGIN);
  const match = /^\/api\/projects\/([^/]+)\/(preview|renders\/file)\/(.+)$/.exec(url.pathname);
  const projectId = request.projectId ?? (match ? decodeURIComponent(match[1]) : undefined);
  if (!projectId || url.protocol !== "mpvfx:" || url.host !== "editor") {
    throw new Error("Video thumbnails require an imported project media file");
  }
  if (match && decodeURIComponent(match[1]) !== projectId) {
    throw new Error("Video source belongs to a different project");
  }
  const source = match ? decodeURIComponent(match[3]) : decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const payload: VideoFramesRequest = {
    source, sourceStart: request.sourceStart, sourceRangeDuration: request.sourceRangeDuration,
    location: match?.[2] === "renders/file" ? "render" : "project",
    frameCount: Math.min(Math.max(1, Math.floor(request.frameCount)), budgets.richPreviewFrameCount),
    width: budgets.posterMaxPhysicalWidth, height: budgets.posterMaxPhysicalHeight,
  };
  const response = await desktopRequest(`/api/projects/${encodeURIComponent(projectId)}/media/frames`, {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Native frame decoding failed (${response.status})`);
  const decoded = await response.json() as VideoFramesResult;
  signal.throwIfAborted();
  if (!Array.isArray(decoded.frames) || !decoded.frames.length || decoded.frames.length > 6 ||
      !(decoded.aspect > 0) || !Number.isFinite(decoded.aspect) ||
      !(decoded.width > 0 && decoded.width <= 480 && decoded.height > 0 && decoded.height <= 270)) {
    throw new Error("Native decoder returned no video frames");
  }
  const urls: string[] = [];
  const dispose = () => { for (const url of urls.splice(0)) URL.revokeObjectURL(url); };
  try {
    for (const frame of decoded.frames) {
      signal.throwIfAborted();
      const bytes = Uint8Array.from(atob(frame), (character) => character.charCodeAt(0));
      urls.push(URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })));
    }
    return {
      duration: decoded.duration,
      value: urls.length === 1
        ? { kind: "image", url: urls[0], aspect: decoded.aspect }
        : { kind: "filmstrip", urls: [...urls], aspect: decoded.aspect },
      weight: decoded.width * decoded.height * 4 * urls.length,
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}
