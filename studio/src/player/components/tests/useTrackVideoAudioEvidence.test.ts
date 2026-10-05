import { describe, expect, it } from "vitest";
import type { PreviewElementState } from "../../../../shared/preview/agentProtocol";
import type { TimelineElement } from "../../store/playerStore";
import { audibleVideoKeys } from "../useTrackVideoAudioEvidence";

const video = (id: string, sourceFile = "index.html"): TimelineElement => ({
  id: `clip:${id}`, domId: id, sourceFile, tag: "video", start: 0, duration: 2, track: 0,
});
const state = (id: string, sourceFile = "index.html", hasAudio = "true"): PreviewElementState => ({
  handle: "e1", tag: "video", id, className: "", text: "",
  rect: { x: 0, y: 0, width: 100, height: 100 }, visible: true, parent: null,
  sourceFile, compositionPath: sourceFile,
  dataAttributes: { "has-audio": hasAudio }, inlineStyles: {}, computedStyles: {},
});

describe("audibleVideoKeys", () => {
  it("requires explicit audio and exact source scoped identity", () => {
    expect([...audibleVideoKeys(
      [video("camera"), video("camera", "compositions/other.html"), video("silent")],
      [state("camera"), state("silent", "index.html", "false")],
    )]).toEqual(["clip:camera"]);
  });
});
