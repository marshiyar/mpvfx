import { describe, expect, it } from "vitest";
import { getCategory } from "../components/sidebar/assetHelpers";
import { getTimelineAssetKind } from "./timelineAssetDrop";
import { isMediaFile } from "./mediaTypes";
import { SUPPORTED_MEDIA_IMPORT_EXTENSIONS } from "./mediaImportPolicy";

describe("media import surface parity", () => {
  it.each([
    ["video", "video"],
    ["audio", "audio"],
    ["image", "images"],
  ] as const)("keeps every %s format visible and timeline-insertable", (kind, category) => {
    for (const extension of SUPPORTED_MEDIA_IMPORT_EXTENSIONS[kind]) {
      const path = `assets/sample.${extension}`;
      expect(isMediaFile(path), path).toBe(true);
      expect(getCategory(path), path).toBe(category);
      expect(getTimelineAssetKind(path), path).toBe(kind);
    }
  });

  it("keeps every supported font visible but off the timeline", () => {
    for (const extension of SUPPORTED_MEDIA_IMPORT_EXTENSIONS.font) {
      const path = `assets/fonts/sample.${extension}`;
      expect(isMediaFile(path), path).toBe(false);
      expect(getCategory(path), path).toBe("fonts");
      expect(getTimelineAssetKind(path), path).toBeNull();
    }
  });

  it("keeps LUTs in their dedicated inspector import instead of the media library", () => {
    expect(isMediaFile("assets/luts/look.cube")).toBe(false);
    expect(getCategory("assets/luts/look.cube")).toBeNull();
    expect(getTimelineAssetKind("assets/luts/look.cube")).toBeNull();
  });

  it("uses the same classification for uppercase and URL-suffixed media", () => {
    expect(getCategory("assets/TAKE.M4V?v=2")).toBe("video");
    expect(getTimelineAssetKind("assets/VOICE.AAC#preview")).toBe("audio");
    expect(isMediaFile("assets/POSTER.AVIF?rev=3")).toBe(true);
  });
});
