// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  inspectMediaImportFile,
  partitionMediaImportFiles,
} from "./mediaImportPolicy";

function file(name: string, type = "", contents = "x"): File {
  return new File([contents], name, { type });
}

describe("media import validation", () => {
  it.each([
    ["clip.mp4", "video/mp4", "video"],
    ["camera.M4V", "video/mp4", "video"],
    ["voice.aac", "audio/aac", "audio"],
    ["logo.avif", "image/avif", "image"],
    ["display.woff2", "font/woff2", "font"],
    ["grade.cube", "text/plain", "lut"],
  ] as const)("accepts %s (%s) as %s", (name, type, kind) => {
    expect(inspectMediaImportFile(file(name, type))).toMatchObject({ accepted: true, kind });
  });

  it("accepts an empty or generic OS MIME type when the extension is supported", () => {
    expect(inspectMediaImportFile(file("camera.mov"))).toMatchObject({
      accepted: true,
      kind: "video",
    });
    expect(inspectMediaImportFile(file("voice.aac", "application/octet-stream"))).toMatchObject({
      accepted: true,
      kind: "audio",
    });
  });

  it("rejects empty files before upload", () => {
    expect(inspectMediaImportFile(file("empty.png", "image/png", ""))).toEqual({
      accepted: false,
      reason: "empty-file",
    });
  });

  it("rejects unsupported and extensionless files", () => {
    expect(inspectMediaImportFile(file("notes.pdf", "application/pdf"))).toEqual({
      accepted: false,
      reason: "unsupported-extension",
    });
    expect(inspectMediaImportFile(file("camera", "video/mp4"))).toEqual({
      accepted: false,
      reason: "unsupported-extension",
    });
  });

  it("rejects an explicit cross-kind MIME mismatch but tolerates MIME aliases", () => {
    expect(inspectMediaImportFile(file("poster.png", "video/mp4"))).toEqual({
      accepted: false,
      reason: "mime-type-mismatch",
    });
    expect(inspectMediaImportFile(file("voice.wav", "audio/x-wav"))).toMatchObject({
      accepted: true,
      kind: "audio",
    });
    expect(inspectMediaImportFile(file("movie.m4v", "video/x-m4v"))).toMatchObject({
      accepted: true,
      kind: "video",
    });
  });

  it("partitions a mixed drop without changing the accepted file order", () => {
    const files = [
      file("one.mov", "video/quicktime"),
      file("readme.txt", "text/plain"),
      file("two.aac", "audio/aac"),
      file("empty.jpg", "image/jpeg", ""),
      file("three.webp", "image/webp"),
    ];
    const result = partitionMediaImportFiles(files);
    expect(result.accepted.map((entry) => entry.file.name)).toEqual([
      "one.mov",
      "two.aac",
      "three.webp",
    ]);
    expect(result.rejected).toEqual([
      { file: files[1], reason: "unsupported-extension" },
      { file: files[3], reason: "empty-file" },
    ]);
  });

  it.each([
    ["display.ttf", "application/x-font-ttf"],
    ["display.otf", "application/x-font-opentype"],
    ["display.woff", "application/x-font-woff"],
  ])("accepts the common legacy font MIME alias for %s", (name, type) => {
    expect(inspectMediaImportFile(file(name, type))).toMatchObject({ accepted: true, kind: "font" });
  });
});
