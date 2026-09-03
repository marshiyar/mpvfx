import { preferredMediaImportMimeType } from "./src/utils/mediaImportPolicy";

export function resolvePreviewResponseContentType(
  requestPath: string,
  upstreamContentType: string | null | undefined,
): string | null | undefined {
  if (upstreamContentType && upstreamContentType !== "application/octet-stream") {
    return upstreamContentType;
  }
  return preferredMediaImportMimeType(requestPath) ?? upstreamContentType;
}
