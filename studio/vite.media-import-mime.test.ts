import { describe, expect, it } from "vitest";
import { resolvePreviewResponseContentType } from "./vite.media-import-mime";

describe("standalone preview MIME fallback for imported files", () => {
  it.each([
    ["/projects/p/preview/assets/clip.avi", "video/x-msvideo"],
    ["/projects/p/preview/assets/clip.mxf", "video/mxf"],
    ["/projects/p/preview/assets/clip.m2ts", "video/mp2t"],
    ["/projects/p/preview/assets/voice.flac", "audio/flac"],
    ["/projects/p/preview/assets/voice.opus", "audio/ogg"],
    ["/projects/p/preview/assets/poster.avif", "image/avif"],
    ["/projects/p/preview/assets/display.ttc", "font/collection"],
    ["/projects/p/preview/assets/legacy.eot", "application/vnd.ms-fontobject"],
  ])("serves %s with %s when the upstream response is generic", (path, expected) => {
    expect(resolvePreviewResponseContentType(path, "application/octet-stream")).toBe(expected);
  });

  it("preserves an upstream specific MIME type", () => {
    expect(resolvePreviewResponseContentType("/preview/poster.avif", "image/custom")).toBe(
      "image/custom",
    );
  });

  it("leaves an unknown binary response generic", () => {
    expect(resolvePreviewResponseContentType("/preview/archive.zip", "application/octet-stream")).toBe(
      "application/octet-stream",
    );
  });
});
