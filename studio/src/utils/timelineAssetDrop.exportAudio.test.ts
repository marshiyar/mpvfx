import { parseAudioElements } from "@hyperframes/engine";
import { describe, expect, it } from "vitest";

import { buildTimelineAssetInsertHtml } from "./timelineAssetDrop";

describe("inserted video export audio discovery", () => {
  it.each(["mp4", "m4v", "mov", "webm"])(
    "keeps the .%s video's audio in the offline export mix",
    (extension) => {
      const html = buildTimelineAssetInsertHtml({
        id: `camera_${extension}`,
        hfId: `hf-camera-${extension}`,
        assetPath: `assets/camera.${extension}`,
        kind: "video",
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
