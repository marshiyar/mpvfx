import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMAT_CAPABILITIES,
  SUPPORTED_EXPORT_FORMATS,
  UNSUPPORTED_STANDALONE_EXPORT_FORMATS,
  isExportFormat,
} from "./exportPolicy";

describe("standalone export formats", () => {
  it("defines every format the standalone render route can produce", () => {
    expect(SUPPORTED_EXPORT_FORMATS).toEqual(["mp4", "webm", "mov"]);
  });

  it.each([
    ["mp4", ".mp4", "video/mp4"],
    ["webm", ".webm", "video/webm"],
    ["mov", ".mov", "video/quicktime"],
  ] as const)("maps %s to its exact extension and MIME type", (format, extension, mimeType) => {
    expect(EXPORT_FORMAT_CAPABILITIES[format]).toMatchObject({ extension, mimeType });
    expect(isExportFormat(format)).toBe(true);
  });

  it.each(["gif", "png-sequence", "avi", "mkv", "mxf", "mp3", "wav"])(
    "does not advertise unsupported standalone output %s",
    (format) => expect(isExportFormat(format)).toBe(false),
  );

  it("documents producer formats that the standalone route does not expose", () => {
    expect(UNSUPPORTED_STANDALONE_EXPORT_FORMATS).toEqual({
      gif: "not exposed by the standalone Studio render route",
      "png-sequence": "not exposed by the standalone Studio render route",
    });
  });
});
