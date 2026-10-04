/** Stream facts from the original media, independent of a clip's mute setting. */
export interface MediaMetadata {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
}
