import { describe, expect, it } from "vitest";
import { getCategory } from "./assetHelpers";
import { getTimelineAssetKind } from "../timeline/timelineAssetDrop";
import { isMediaFile } from "./mediaTypes";
import { SUPPORTED_MEDIA_IMPORT_EXTENSIONS } from "../../../shared/media/mediaImportPolicy";

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

  it("recognizes uppercase extensions after literal filename punctuation on every surface", () => {
    for (const [path, category, kind] of [
      ["assets/TAKE?v=2.M4V", "video", "video"],
      ["assets/VOICE#preview.AAC", "audio", "audio"],
      ["assets/POSTER?rev=3.AVIF", "images", "image"],
    ]) {
      expect(getCategory(path)).toBe(category);
      expect(getTimelineAssetKind(path)).toBe(kind);
      expect(isMediaFile(path)).toBe(true);
    }
  });
});
