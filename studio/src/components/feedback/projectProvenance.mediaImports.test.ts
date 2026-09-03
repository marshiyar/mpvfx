import { beforeEach, describe, expect, it } from "vitest";
import { SUPPORTED_MEDIA_IMPORT_EXTENSIONS } from "../../utils/mediaImportPolicy";
import {
  captureProjectProvenance,
  projectProvenance,
  resetProjectProvenance,
} from "./projectProvenance";

describe("project provenance media-import parity", () => {
  beforeEach(() => resetProjectProvenance());

  it("counts every supported timeline media format and excludes fonts, LUTs, and source files", () => {
    const mediaFiles = (["video", "audio", "image"] as const).flatMap((kind) =>
      SUPPORTED_MEDIA_IMPORT_EXTENSIONS[kind].map((extension) => `assets/sample.${extension}`),
    );
    const nonMediaFiles = [
      ...SUPPORTED_MEDIA_IMPORT_EXTENSIONS.font.map((extension) =>
        `assets/fonts/sample.${extension}`,
      ),
      "assets/luts/look.cube",
      "index.html",
      "script.js",
    ];

    captureProjectProvenance("project", [...mediaFiles, ...nonMediaFiles], ["index.html"]);

    expect(projectProvenance().project_media_count).toBe(mediaFiles.length);
  });
});
