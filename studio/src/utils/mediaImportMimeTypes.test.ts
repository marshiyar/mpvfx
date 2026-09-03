// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_MEDIA_IMPORT_EXTENSIONS,
  inspectMediaImportFile,
  preferredMediaImportMimeType,
} from "./mediaImportPolicy";

const EXPECTED_MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  ttc: "font/collection",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  cube: "text/plain; charset=utf-8",
};

describe("media import MIME contract", () => {
  const supportedExtensions = Object.values(SUPPORTED_MEDIA_IMPORT_EXTENSIONS).flat();

  it("has one exact, non-generic MIME type for every supported extension", () => {
    expect(Object.keys(EXPECTED_MIME_BY_EXTENSION).sort()).toEqual([...supportedExtensions].sort());
    for (const extension of supportedExtensions) {
      const expected = EXPECTED_MIME_BY_EXTENSION[extension];
      expect(preferredMediaImportMimeType(`assets/file.${extension}`), extension).toBe(expected);
      expect(expected, extension).not.toBe("application/octet-stream");
    }
  });

  it("does not let a supported MIME type make an unsupported extension importable", () => {
    expect(
      inspectMediaImportFile(new File(["video"], "clip.exe", { type: "video/mp4" })),
    ).toEqual({ accepted: false, reason: "unsupported-extension" });
  });
});
