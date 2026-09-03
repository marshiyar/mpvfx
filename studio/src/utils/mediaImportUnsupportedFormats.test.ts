// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { classifyMediaImportPath, inspectMediaImportFile } from "./mediaImportPolicy";

describe("formats that are not yet safe standalone imports", () => {
  it.each(["mkv", "avi", "mxf", "mts", "m2ts", "ts"])(
    "rejects .%s until every common container codec has a browser-safe proxy",
    (extension) => {
      const file = new File(["video"], `clip.${extension}`, { type: "video/unknown" });
      expect(classifyMediaImportPath(file.name)).toBeNull();
      expect(inspectMediaImportFile(file)).toEqual({
        accepted: false,
        reason: "unsupported-extension",
      });
    },
  );

  it.each(["flac", "opus"])(
    "rejects .%s until the upload server validates its audio stream",
    (extension) => {
      const file = new File(["audio"], `voice.${extension}`, { type: "audio/unknown" });
      expect(classifyMediaImportPath(file.name)).toBeNull();
      expect(inspectMediaImportFile(file)).toEqual({
        accepted: false,
        reason: "unsupported-extension",
      });
    },
  );
});
