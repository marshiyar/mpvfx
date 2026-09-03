import { describe, expect, it } from "vitest";
import {
  FONT_IMPORT_ACCEPT,
  IMAGE_IMPORT_ACCEPT,
  LUT_IMPORT_ACCEPT,
  MEDIA_IMPORT_ACCEPT,
  SUPPORTED_MEDIA_IMPORT_EXTENSIONS,
  classifyMediaImportPath,
  isImportableMediaPath,
} from "./mediaImportPolicy";

const EXPECTED_FORMATS = {
  video: ["mp4", "m4v", "mov", "webm"],
  audio: ["mp3", "wav", "ogg", "m4a", "aac"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "ico"],
  font: ["woff", "woff2", "ttf", "ttc", "otf", "eot"],
  lut: ["cube"],
} as const;

describe("media import format catalog", () => {
  it("lists every supported video container in one explicit contract", () => {
    expect(SUPPORTED_MEDIA_IMPORT_EXTENSIONS.video).toEqual(EXPECTED_FORMATS.video);
  });

  it("lists every supported audio container in one explicit contract", () => {
    expect(SUPPORTED_MEDIA_IMPORT_EXTENSIONS.audio).toEqual(EXPECTED_FORMATS.audio);
  });

  it("lists every supported still-image format in one explicit contract", () => {
    expect(SUPPORTED_MEDIA_IMPORT_EXTENSIONS.image).toEqual(EXPECTED_FORMATS.image);
  });

  it("keeps font and color-LUT imports explicit without treating them as timeline media", () => {
    expect(SUPPORTED_MEDIA_IMPORT_EXTENSIONS.font).toEqual(EXPECTED_FORMATS.font);
    expect(SUPPORTED_MEDIA_IMPORT_EXTENSIONS.lut).toEqual(EXPECTED_FORMATS.lut);
    expect(isImportableMediaPath("assets/fonts/title.woff2")).toBe(false);
    expect(isImportableMediaPath("assets/luts/cinema.cube")).toBe(false);
  });

  it.each(
    Object.entries(EXPECTED_FORMATS).flatMap(([kind, extensions]) =>
      extensions.map((extension) => [kind, extension] as const),
    ),
  )("classifies .%s/%s imports case-insensitively in nested paths", (kind, extension) => {
    const expectedKind = kind === "image" ? "image" : kind;
    expect(classifyMediaImportPath(`nested/My Asset.${extension.toUpperCase()}`)).toBe(expectedKind);
  });

  it("classifies cache-busted and fragment-bearing asset URLs", () => {
    expect(classifyMediaImportPath("assets/clip.M4V?v=2#preview")).toBe("video");
    expect(classifyMediaImportPath("assets/voice.AAC#take-2")).toBe("audio");
    expect(classifyMediaImportPath("assets/poster.AVIF?rev=3")).toBe("image");
  });

  it("does not turn project/code/archive files into media imports", () => {
    for (const path of [
      "index.html",
      "script.js",
      "styles.css",
      "project.json",
      "notes.md",
      "archive.zip",
      "installer.exe",
      "no-extension",
    ]) {
      expect(classifyMediaImportPath(path), path).toBeNull();
      expect(isImportableMediaPath(path), path).toBe(false);
    }
  });

  it("builds the file-picker accept value from every main-library extension", () => {
    const accepted = new Set(MEDIA_IMPORT_ACCEPT.split(","));
    for (const kind of ["video", "audio", "image", "font"] as const) {
      for (const extension of EXPECTED_FORMATS[kind]) {
        expect(accepted.has(`.${extension}`), extension).toBe(true);
      }
    }
    expect(accepted.has(".cube")).toBe(false);
    expect(MEDIA_IMPORT_ACCEPT).not.toContain("*");
  });

  it("derives the image, font, and LUT inspector pickers from their format groups", () => {
    expect(IMAGE_IMPORT_ACCEPT).toBe(EXPECTED_FORMATS.image.map((ext) => `.${ext}`).join(","));
    expect(FONT_IMPORT_ACCEPT).toBe(EXPECTED_FORMATS.font.map((ext) => `.${ext}`).join(","));
    expect(LUT_IMPORT_ACCEPT).toBe(".cube");
  });
});
