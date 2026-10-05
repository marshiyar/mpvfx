import { parseAudioElements } from "@hyperframes/engine";
import { describe, expect, it } from "vitest";

import { buildTimelineAssetInsertHtml } from "../timelineAssetDrop";

describe("inserted video export audio discovery", () => {
  it.each(["mp4", "m4v", "mov", "webm"])(
    "keeps the .%s video's audio in the offline export mix",
    (extension) => {
      const html = buildTimelineAssetInsertHtml({
        id: `camera_${extension}`,
        hfId: `hf-camera-${extension}`,
        assetPath: `assets/camera.${extension}`,
        kind: "video",
        hasAudio: true,
        start: 0,
        duration: 5,
        track: 0,
        zIndex: 1,
      });

      expect(parseAudioElements(html)).toEqual([
        expect.objectContaining({
          id: `camera_${extension}-audio`,
          type: "video",
          src: `assets/camera.${extension}`,
        }),
      ]);
    },
  );
});

// A silent video is still a picture clip; it must not create an audio source.
it.each([false, undefined])("does not invent audio when stream presence is %s", hasAudio => {
  const html = buildTimelineAssetInsertHtml({ id: "silent", hfId: "hf-silent", assetPath: "assets/silent.mp4",
    kind: "video", hasAudio, start: 0, duration: 1, track: 0, zIndex: 0 });
  expect(html).toContain("<video ");
  expect(parseAudioElements(html)).toEqual([]);
  if (hasAudio === undefined) expect(html).not.toContain("data-has-audio");
});
