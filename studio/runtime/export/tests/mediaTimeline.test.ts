import { describe, expect, it } from "vitest";
import { parseNativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { mediaTimelineForExport } from "../mediaTimeline";

const project = () => parseNativeProjectDocument({
  schemaVersion: 1, id: "test", revision: 1, frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 1920, height: 1080, background: "#000000" },
  assets: [{ id: "video", kind: "video", name: "clip.mov", durationFrames: 90 }],
  sequence: { id: "sequence", name: "Sequence", tracks: [{ id: "v", kind: "video", clips: [
    { id: "clip", assetId: "video", binding: { sourceFile: "index.html", domId: "clip", hfId: "hf-clip" },
      startFrame: 15, durationFrames: 60, sourceInFrame: 30, effects: [], parameterTracks: [] },
  ] }] },
});
const html = `<html><head><style>html,body{width:1920px;height:1080px;margin:0;overflow:hidden;background:#0a0a0b}#root{position:relative;width:1920px;height:1080px;overflow:hidden}</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="5" data-width="1920" data-height="1080"><video id="clip" data-hf-id="hf-clip" class="clip" src="assets/clip.mov" data-start="0.5" data-duration="2" style="position:absolute;left:100px;top:200px;width:640px;height:360px;object-fit:contain;z-index:3"></video></div></body></html>`;

describe("legacy media import boundary", () => {
  it("extracts media paths and geometry while keeping native timing authoritative", () => {
    const original = project();
    const result = mediaTimelineForExport(original, html)!;
    expect(result.assets[0].source).toBe("assets/clip.mov");
    expect(result.canvas.background).toBe("#0a0a0b");
    expect(result.sequence.durationFrames).toBe(150);
    expect(result.sequence.tracks[0].clips[0]).toMatchObject({
      startFrame: 15, durationFrames: 60, sourceInFrame: 30,
      staticParameters: { "layout.left": 100, "layout.top": 200, "layout.width": 640, "layout.height": 360, "layout.zIndex": 3 },
    });
    expect(result.sequence.tracks[0].clips[0].binding).toBeUndefined();
    expect(original.sequence.tracks[0].clips[0].binding).toBeDefined();
    expect(original.assets[0].source).toBeUndefined();
  });

  it.each([
    html.replace("</div>", "<p>Keep this title</p></div>"),
    html.replace("</body>", "<script>animateSomething()</script></body>"),
    html.replace("object-fit:contain", "object-fit:cover"),
    html.replace("z-index:3", "z-index:3;filter:blur(3px)"),
    html.replace('id="root"', 'id="root" hidden'),
    html.replace('data-hf-id="hf-clip"', 'data-hf-id="wrong"'),
  ])("keeps unrepresented legacy content on its existing renderer", source => {
    expect(mediaTimelineForExport(project(), source)).toBeNull();
  });

  it("renders an independent media document without consulting HTML", () => {
    const document = project();
    document.mediaEngine = "ffmpeg";
    document.assets[0].source = "assets/clip.mov";
    delete document.sequence.tracks[0].clips[0].binding;
    expect(mediaTimelineForExport(document)).toBe(document);
  });

  it("rejects incomplete native media documents instead of guessing a source", () => {
    const document = project();
    document.mediaEngine = "ffmpeg";
    delete document.sequence.tracks[0].clips[0].binding;
    expect(() => mediaTimelineForExport(document)).toThrow("Media path is missing");
  });

  it("does not treat an empty legacy sidecar as a complete native project", () => {
    const document = project();
    document.assets = []; document.sequence.tracks = [];
    expect(mediaTimelineForExport(document, html)).toBeNull();
  });
});
