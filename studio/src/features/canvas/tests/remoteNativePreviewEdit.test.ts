import { describe, expect, it, vi } from "vitest";
import type { PreviewElementState } from "../../../../shared/preview/agentProtocol";
import { parseNativeProjectDocument } from "../../../../shared/project/nativeProjectDocument";
import type { NativeKeyframeProjectCommit } from "../../../player/components/deleteSelectedKeyframes";
import { commitRemoteNativeMove, resolveRemoteNativeClip } from "../remoteNativePreviewEdit";

const document = parseNativeProjectDocument({
  schemaVersion: 1, id: "project", revision: 0,
  frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 100, height: 100, background: "#000000" },
  assets: [{ id: "asset", kind: "video", name: "video", source: "video.mp4", durationFrames: 300 }],
  sequence: { id: "main", name: "Main", tracks: [{ id: "track", kind: "video", clips: [{
    id: "clip", assetId: "asset", binding: { sourceFile: "index.html", domId: "video" },
    startFrame: 0, durationFrames: 60, sourceInFrame: 0, muted: false, effects: [], parameterTracks: [],
    staticParameters: { "transform.position.x": 10, "transform.position.y": 20 },
  }] }] },
});

const target: PreviewElementState = {
  handle: "e1", tag: "video", id: "video", className: "", text: "",
  rect: { x: 0, y: 0, width: 100, height: 100 }, visible: true, parent: null,
  sourceFile: "index.html", compositionPath: "index.html",
  dataAttributes: { "studio-clip-id": "clip" }, inlineStyles: {}, computedStyles: {},
};

describe("remote native preview editing", () => {
  it("resolves only exact clips in the active native document", () => {
    expect(resolveRemoteNativeClip(document, target)?.clip.id).toBe("clip");
    expect(resolveRemoteNativeClip(document, { ...target, sourceFile: "other.html" })).toBeNull();
    expect(resolveRemoteNativeClip(document, { ...target, dataAttributes: { "studio-clip-id": "other" } })).toBeNull();
  });

  it("commits a move through the existing native project transaction", async () => {
    const commit = vi.fn(async (_change: NativeKeyframeProjectCommit) => true);
    expect(await commitRemoteNativeMove(document, target, { x: 5, y: -2 }, commit)).toBe(true);
    const next = commit.mock.calls[0]![0].document;
    expect(next.sequence.tracks[0]!.clips[0]!.staticParameters).toMatchObject({
      "transform.position.x": 15, "transform.position.y": 18,
    });
    expect(document.sequence.tracks[0]!.clips[0]!.staticParameters).toMatchObject({
      "transform.position.x": 10, "transform.position.y": 20,
    });
    expect(commit.mock.calls[0]![0].inverse).toEqual({ type: "restore-document", document });
    expect(await commitRemoteNativeMove(document, { ...target, sourceFile: "other.html" }, { x: 1, y: 1 }, commit)).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
