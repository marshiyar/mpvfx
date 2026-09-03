import { mediaImportExtensionPattern } from "./mediaImportPolicy";

export const IMAGE_EXT = mediaImportExtensionPattern(["image"]);
export const VIDEO_EXT = mediaImportExtensionPattern(["video"]);
export const AUDIO_EXT = mediaImportExtensionPattern(["audio"]);
export const FONT_EXT = mediaImportExtensionPattern(["font"]);
export const LUT_EXT = mediaImportExtensionPattern(["lut"]);
export const MEDIA_EXT = mediaImportExtensionPattern(["video", "audio", "image"]);

export function isMediaFile(path: string): boolean {
  return MEDIA_EXT.test(path);
}
