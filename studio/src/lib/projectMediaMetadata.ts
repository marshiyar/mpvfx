import { desktopRequest } from "./desktopClient";
import type { MediaMetadata } from "../../shared/media/mediaMetadata";

export async function resolveProjectMediaMetadata(projectId: string, source: string): Promise<MediaMetadata | null> {
  try {
    const response = await desktopRequest(
      `/api/projects/${encodeURIComponent(projectId)}/media/streams?source=${encodeURIComponent(source)}`,
    );
    if (!response.ok) return null;
    const metadata = await response.json() as Partial<MediaMetadata>;
    return typeof metadata.duration === "number" && Number.isFinite(metadata.duration) && metadata.duration > 0 &&
      typeof metadata.hasVideo === "boolean" && typeof metadata.hasAudio === "boolean"
      ? metadata as MediaMetadata : null;
  } catch {
    return null;
  }
}

/** Unknown is kept distinct from silent when the native probe is unavailable. */
export async function resolveProjectVideoAudio(projectId: string, source: string): Promise<boolean | undefined> {
  const metadata = await resolveProjectMediaMetadata(projectId, source);
  return metadata?.hasVideo ? metadata.hasAudio : undefined;
}
