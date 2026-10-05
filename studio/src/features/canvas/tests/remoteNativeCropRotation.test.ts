// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewElementState } from "../../../../shared/preview/agentProtocol";
import { parseNativeProjectDocument, serializeNativeProjectDocument } from "../../../../shared/project/nativeProjectDocument";
import { createNativeParameterTrack } from "../../../../shared/project/nativeKeyframeTypes";
import { applyNativeFrameToDocument } from "../../project/nativeFrameApplication";
import { createNativeProjectRenderBodyScript } from "../../../../runtime/export/nativeProject";
import { commitRemoteNativeCropRotation, planRemoteNativeCropRotation,
  remoteVisibleCropRect } from "../remoteNativeCropRotation";

const frameRate = { numerator: 30, denominator: 1 };
const track = (id: string, values: number[]) => createNativeParameterTrack({
  id, parameterId: id, valueType: "number", frameRate,
  keyframes: values.map((value, index) => ({ id: `${id}:${index}`, frame: index * 45,
    value, outgoing: { type: "linear" as const } })),
});
const project = (animated: boolean) => parseNativeProjectDocument({
  schemaVersion: 1, id: "project:pivot", revision: 4, frameRate,
  canvas: { width: 640, height: 360, background: "#fff" },
  assets: [{ id: "asset", kind: "video", name: "source", source: "a.mp4", durationFrames: 300 }],
  sequence: { id: "sequence", name: "Main", tracks: [{ id: "track", kind: "video", clips: [{
    id: "clip", assetId: "asset", startFrame: 30, durationFrames: 120,
    sourceInFrame: 92, sourceInFraction: { numerator: 1, denominator: 2 },
    playbackRate: { numerator: 3, denominator: 2 }, muted: true, effects: [],
    binding: { sourceFile: "index.html", domId: "video" },
    staticParameters: animated ? { "layout.width": 200, "layout.height": 100 } : {},
    parameterTracks: animated ? [track("transform.rotation", [0, 45, 90]),
      track("transform.position.x", [0, 0, 0]), track("transform.position.y", [0, -10, -20])] : [],
  }] }] },
});
const state = (rotation: number, y: number): PreviewElementState => {
  const angle = rotation * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { handle: "e1", tag: "video", id: "video", className: "", text: "", textEditable: false,
    visible: true, parent: null, sourceFile: "index.html", compositionPath: "index.html",
    dataAttributes: { "studio-clip-id": "clip" },
    rect: { x: 0, y: 0, width: Math.abs(cosine) * 200 + Math.abs(sine) * 100,
      height: Math.abs(sine) * 200 + Math.abs(cosine) * 100 },
    inlineStyles: { "clip-path": "inset(10px 20px 30px 40px)" },
    computedStyles: { width: "200px", height: "100px", "transform-origin": "100px 50px",
      transform: rotation === 0 && y === 0 ? "none"
        : `matrix(${cosine}, ${sine}, ${-sine}, ${cosine}, 0, ${y})` },
  };
};

afterEach(() => document.body.replaceChildren());

describe("remote cropped native rotation", () => {
  it("hugs the visible crop edge and center instead of the hidden source box", () => {
    expect(remoteVisibleCropRect(state(0, 0))).toEqual({ x: 40, y: 10, width: 140, height: 60 });
    const rotated = remoteVisibleCropRect(state(45, -10))!;
    const source = state(45, -10).rect;
    expect(rotated.x + rotated.width / 2 - (source.x + source.width / 2))
      .toBeCloseTo(Math.SQRT2 * 10, 6);
    expect(rotated.y + rotated.height / 2 - (source.y + source.height / 2))
      .toBeCloseTo(0, 6);
  });

  it("commits a static visible-center pose in one undo snapshot without touching fractional source timing", async () => {
    const before = project(false);
    const commit = vi.fn(async () => true);
    expect(await commitRemoteNativeCropRotation(before, state(0, 0), 30, 90, commit)).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    const change = commit.mock.calls[0]![0] as { document: typeof before; inverse: { document: typeof before } };
    const clip = change.document.sequence.tracks[0]!.clips[0]!;
    expect(clip.staticParameters).toMatchObject({ "transform.rotation": 90,
      "transform.position.x": 0, "transform.position.y": -20 });
    expect(clip.cropPivotSegments).toBeUndefined();
    expect(clip.sourceInFraction).toEqual({ numerator: 1, denominator: 2 });
    expect(clip.playbackRate).toEqual({ numerator: 3, denominator: 2 });
    expect(change.inverse.document).toBe(before);
    expect(parseNativeProjectDocument(JSON.parse(serializeNativeProjectDocument(change.document)))
      .sequence.tracks[0]!.clips[0]!.staticParameters).toEqual(clip.staticParameters);
  });

  it("anchors neighboring animated intervals while keeping all prior keyed poses and export parity", async () => {
    const before = project(true);
    const commit = vi.fn(async () => true);
    expect(await commitRemoteNativeCropRotation(before, state(45, -10), 75, 45, commit)).toBe(true);
    const change = commit.mock.calls[0]![0] as { document: typeof before; inverse: { document: typeof before } };
    const saved = parseNativeProjectDocument(JSON.parse(serializeNativeProjectDocument(change.document)));
    const clip = saved.sequence.tracks[0]!.clips[0]!;
    expect(clip.parameterTracks.find(item => item.parameterId === "transform.rotation")?.keyframes.map(key => key.value))
      .toEqual([0, 90, 90]);
    expect(clip.parameterTracks.find(item => item.parameterId === "transform.position.x")?.keyframes[1]?.value)
      .toBeCloseTo(Math.SQRT2 * 10 - 10, 6);
    expect(clip.parameterTracks.find(item => item.parameterId === "transform.position.y")?.keyframes[1]?.value)
      .toBeCloseTo(-20, 6);
    expect(clip.cropPivotSegments).toHaveLength(2);
    expect(clip.sourceInFrame).toBe(92);
    expect(clip.sourceInFraction).toEqual({ numerator: 1, denominator: 2 });
    expect(change.inverse.document).toBe(before);
    const preview = document.createElement("div");
    preview.id = "video";
    preview.setAttribute("data-studio-clip-id", "clip");
    preview.style.cssText = "width:200px;height:100px;clip-path:inset(10px 20px 30px 40px)";
    const exported = document.createElement("div");
    exported.style.cssText = preview.style.cssText;
    document.body.replaceChildren(preview, exported);
    const frame = 97;
    applyNativeFrameToDocument(document, [{ clipId: clip.id, startFrame: clip.startFrame,
      durationFrames: clip.durationFrames, staticParameters: clip.staticParameters,
      parameterTracks: clip.parameterTracks, cropPivotSegments: clip.cropPivotSegments }], frame);
    const previewTransform = preview.style.transform;
    expect(previewTransform).toContain("rotate(");
    preview.removeAttribute("data-studio-clip-id");
    preview.id = "";
    exported.id = "video";
    window.eval(createNativeProjectRenderBodyScript(serializeNativeProjectDocument(saved))!);
    window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: frame / 30 } }));
    expect(exported.style.transform).toBe(previewTransform);
  });

  it("refuses non-key animated frames and untrusted transform or crop geometry", () => {
    const animated = project(true);
    expect(planRemoteNativeCropRotation(animated, state(45, -10), 76)).toBeNull();
    expect(planRemoteNativeCropRotation(animated, { ...state(45, -10), computedStyles: {
      ...state(45, -10).computedStyles, transform: "matrix3d(1, 0, 0, 0)",
    } }, 75)).toBeNull();
    expect(planRemoteNativeCropRotation(animated, { ...state(45, -10), inlineStyles: {
      "clip-path": "polygon(0 0, 100% 0, 100% 100%)",
    } }, 75)).toBeNull();
  });
});
