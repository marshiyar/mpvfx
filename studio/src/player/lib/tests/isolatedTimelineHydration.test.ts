import { describe, expect, it } from "vitest";
import type { PreviewElementState } from "../../../../shared/preview/agentProtocol";
import type { TimelineElement } from "../../store/playerStore";
import { hydrateIsolatedTimelineElements } from "../isolatedTimelineHydration";

const clip: TimelineElement = {
  id: "camera", key: "index.html:camera:0", tag: "video", start: 0, duration: 2, track: 5,
};
function state(id: string, tag: string, sourceFile = "index.html"): PreviewElementState {
  return {
    handle: "e1", id, tag, sourceFile, compositionPath: sourceFile,
    className: "", text: "", rect: { x: 0, y: 0, width: 100, height: 50 },
    visible: true, parent: null, selector: `#${id}`,
    dataAttributes: {}, inlineStyles: {}, computedStyles: {},
  };
}

describe("hydrateIsolatedTimelineElements", () => {
  it("restores source-scoped media, group, FX and visibility metadata", () => {
    const media = state("camera", "video");
    media.dataAttributes = {
      "hf-id": "hf-camera", "audio-group": "dialogue", hidden: "",
      "fx-chain": "fx", volume: "0.5", "timeline-role": "music",
    };
    media.computedStyles = { "z-index": "17" };
    const bus = state("dialogue", "hf-audio-group");
    bus.dataAttributes = { label: "Dialogue", volume: "0.4", hidden: "", "fx-chain": "bus-fx" };
    expect(hydrateIsolatedTimelineElements([clip], [media, bus])).toEqual([expect.objectContaining({
      id: "camera", key: "index.html#camera", domId: "camera", hfId: "hf-camera",
      sourceFile: "index.html", hidden: true, zIndex: 17, volume: 0.5,
      audioGroup: "dialogue", audioGroupLabel: "Dialogue", audioGroupVolume: 0.4,
      audioGroupHidden: true, audioGroupFxChain: "bus-fx", fxChain: "fx", timelineRole: "music",
    })]);
  });

  it("does not guess between duplicate ids or accept a path outside the project", () => {
    expect(hydrateIsolatedTimelineElements([clip], [state("camera", "video"), state("camera", "video", "other.html")])).toEqual([clip]);
    expect(hydrateIsolatedTimelineElements([clip], [state("camera", "video", "../other.html")])).toEqual([clip]);
  });
});
