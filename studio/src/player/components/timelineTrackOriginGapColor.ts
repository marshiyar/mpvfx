import type { TimelineElement } from "../store/playerStore";
import type { TimelineTheme } from "./timelineTheme";

export const PHOTO_ORIGIN_GAP_COLOR = "#3B82F6";
export const AUDIO_ORIGIN_GAP_COLOR = "#A855F7";

/** Media-kind cue for the fixed pre-roll area before time zero. */
export function timelineTrackOriginGapColor(
  elements: readonly TimelineElement[],
  theme: TimelineTheme,
): string {
  if (elements.some((element) => element.tag.toLowerCase() === "video")) {
    return theme.preRollBackground;
  }
  if (elements.some((element) => element.tag.toLowerCase() === "img")) {
    return PHOTO_ORIGIN_GAP_COLOR;
  }
  if (elements.some((element) => element.tag.toLowerCase() === "audio")) {
    return AUDIO_ORIGIN_GAP_COLOR;
  }
  return "transparent";
}
