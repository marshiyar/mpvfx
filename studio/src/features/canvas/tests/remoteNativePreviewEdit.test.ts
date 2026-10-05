import { describe, expect, it, vi } from "vitest";
import type { PreviewElementState } from "../../../../shared/preview/agentProtocol";
import { parseNativeProjectDocument } from "../../../../shared/project/nativeProjectDocument";
import type { NativeKeyframeProjectCommit } from "../../../player/components/deleteSelectedKeyframes";
import { commitRemoteNativeGroupMove, commitRemoteNativeMove, commitRemoteNativeResize, commitRemoteNativeRotation,
  remoteLegacySelectionTargets, remoteNativeCropBaseline, remoteNativeMarqueeTargets,
  remoteNativeResizeBaseline, remoteNativeResizeReady,
  resolveRemoteNativeClip } from "../remoteNativePreviewEdit";

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
  dataAttributes: { "studio-clip-id": "clip" }, inlineStyles: {},
  computedStyles: { width: "100px", height: "100px" },
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

  it("moves two distinct native clips atomically and rejects an unresolved member", async () => {
    const second = { ...document.sequence.tracks[0]!.clips[0]!, id: "clip-2",
      binding: { sourceFile: "index.html", domId: "video-2" },
      staticParameters: { "transform.position.x": 30, "transform.position.y": 40 } };
    const twoClipDocument = parseNativeProjectDocument({ ...document, sequence: {
      ...document.sequence, tracks: [{ ...document.sequence.tracks[0]!, clips: [document.sequence.tracks[0]!.clips[0]!, second] }],
    } });
    const target2 = { ...target, id: "video-2", dataAttributes: { "studio-clip-id": "clip-2" } };
    const commit = vi.fn(async (_change: NativeKeyframeProjectCommit) => true);
    expect(await commitRemoteNativeGroupMove(twoClipDocument, [target, target2], { x: 5, y: -2 }, commit)).toBe(true);
    const clips = commit.mock.calls[0]![0].document.sequence.tracks[0]!.clips;
    expect(clips.map(clip => clip.staticParameters?.["transform.position.x"])).toEqual([15, 35]);
    expect(clips.map(clip => clip.staticParameters?.["transform.position.y"])).toEqual([18, 38]);
    expect(commit.mock.calls[0]![0].inverse).toEqual({ type: "restore-document", document: twoClipDocument });
    expect(await commitRemoteNativeGroupMove(twoClipDocument,
      [target, { ...target2, sourceFile: "wrong.html" }], { x: 5, y: 0 }, commit)).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("rotates a native clip and preserves an exact undo snapshot", async () => {
    const commit = vi.fn(async (_change: NativeKeyframeProjectCommit) => true);
    expect(await commitRemoteNativeRotation(document, target, 45, commit)).toBe(true);
    expect(commit.mock.calls[0]![0].document.sequence.tracks[0]!.clips[0]!.staticParameters?.["transform.rotation"]).toBe(45);
    expect(commit.mock.calls[0]![0].inverse).toEqual({ type: "restore-document", document });
    expect(await commitRemoteNativeRotation(document, target, Infinity, commit)).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("resizes native layout in one batch and refuses invalid or ambiguous targets", async () => {
    const commit = vi.fn(async (_change: NativeKeyframeProjectCommit) => true);
    expect(await commitRemoteNativeResize(document, target, { width: 140, height: 80 }, commit)).toBe(true);
    expect(commit.mock.calls[0]![0].document.sequence.tracks[0]!.clips[0]!.staticParameters).toMatchObject({
      "layout.width": 140, "layout.height": 80,
    });
    expect(await commitRemoteNativeResize(document, target, { width: 0, height: 80 }, commit)).toBe(false);
    expect(await commitRemoteNativeResize(document, { ...target, sourceFile: "other.html" }, { width: 140, height: 80 }, commit)).toBe(false);
    expect(remoteNativeResizeBaseline({ ...target, computedStyles: { ...target.computedStyles, transform: "matrix(0, 1, -1, 0, 0, 0)" } })).toBeNull();
    expect(remoteNativeResizeBaseline({ ...target, computedStyles: { ...target.computedStyles, "clip-path": "inset(1px)" } })).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("holds later gesture handles until the agent reports committed resize geometry", () => {
    const expected = { width: 130, height: 115 };
    expect(remoteNativeResizeReady(target, expected)).toBe(false);
    expect(remoteNativeResizeReady({ ...target, computedStyles: {
      ...target.computedStyles, width: "130px", height: "115px",
    } }, expected)).toBe(true);
    expect(remoteNativeResizeReady({ ...target, computedStyles: {
      ...target.computedStyles, width: "130px", height: "114px",
    } }, expected)).toBe(false);
  });

  it("permits only a measured axis-aligned source box for isolated crop", () => {
    expect(remoteNativeCropBaseline(target)).toEqual({ box: { width: 100, height: 100 },
      insets: { top: 0, right: 0, bottom: 0, left: 0 } });
    expect(remoteNativeCropBaseline({ ...target, computedStyles: {
      ...target.computedStyles, "clip-path": "inset(5px 10px 15px 20px)",
    } })?.insets).toMatchObject({ top: 5, right: 10, bottom: 15, left: 20 });
    expect(remoteNativeCropBaseline({ ...target, computedStyles: {
      ...target.computedStyles, "clip-path": "circle(50%)",
    } })).toBeNull();
    expect(remoteNativeCropBaseline({ ...target, computedStyles: {
      ...target.computedStyles, "clip-path": "inset(60px 0px 60px 0px)",
    } })).toBeNull();
  });

  it("marquee selects only visible uniquely bound native clips inside its box", () => {
    const duplicate = { ...target, handle: "e2" };
    const outside = { ...target, handle: "e3", rect: { x: 200, y: 0, width: 10, height: 10 } };
    const wrong = { ...target, handle: "e4", sourceFile: "other.html" };
    expect(remoteNativeMarqueeTargets(document, [target, duplicate, outside, wrong],
      { x: 5, y: 5, width: 40, height: 40 })).toEqual([target]);
    expect(remoteNativeMarqueeTargets(document, [target],
      { x: 5, y: 5, width: -1, height: 40 })).toEqual([]);
  });

  it("permits legacy inspector selection only for a unique authored identity in the active source", () => {
    const legacy = { ...target, dataAttributes: { "hf-id": "hf-a" } };
    expect(remoteLegacySelectionTargets([legacy], [legacy], "index.html")).toEqual([legacy]);
    expect(remoteLegacySelectionTargets([legacy, { ...legacy, handle: "e2", id: "video-2" }],
      [legacy], "index.html")).toEqual([]);
    expect(remoteLegacySelectionTargets([legacy], [legacy], "other.html")).toEqual([]);
    expect(remoteLegacySelectionTargets([{ ...legacy, id: "", dataAttributes: {} }],
      [{ ...legacy, id: "", dataAttributes: {} }], "index.html")).toEqual([]);
  });
});
