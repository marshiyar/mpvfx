import { describe, expect, it } from "vitest";
import { captureNativeClips, pasteNativeClips } from "./nativeClipClipboard";
import { parseNativeProjectDocument } from "./nativeProjectDocument";

const fixture = () =>
  parseNativeProjectDocument({
    schemaVersion: 1,
    id: "project",
    revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 100, height: 100, background: "#000000" },
    assets: [{ id: "asset", kind: "image", name: "picture.png", durationFrames: 1 }],
    sequence: {
      id: "sequence",
      name: "Main",
      tracks: [
        {
          id: "track",
          kind: "video",
          lane: { authoredTrack: 2, displayTrack: 2 },
          clips: [
            {
              id: "clip",
              assetId: "asset",
              binding: { sourceFile: "index.html", domId: "picture" },
              startFrame: 30,
              durationFrames: 60,
              sourceInFrame: 0,
              muted: false,
              staticParameters: { "layout.width": 100 },
              effects: [{ id: "fx", effectId: "grade", enabled: true }],
              parameterTracks: [
                {
                  schemaVersion: 1,
                  id: "opacity",
                  parameterId: "visual.opacity",
                  valueType: "number",
                  frameRate: { numerator: 30, denominator: 1 },
                  keyframes: [
                    {
                      id: "a",
                      frame: -30,
                      value: 0,
                      outgoing: { type: "linear" },
                    },
                    {
                      id: "b",
                      frame: 90,
                      value: 1,
                      outgoing: { type: "hold" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });
describe("native clip clipboard", () => {
  it("duplicates complete animation handles and metadata with independent identities and no source mutation", () => {
    const source = fixture();
    const before = JSON.stringify(source);
    const snapshot = captureNativeClips(source, [{ id: "picture", sourceFile: "index.html" }]);
    const result = pasteNativeClips(
      source,
      snapshot,
      [{ domId: "picture-copy", hfId: "copy-hf" }],
      "index.html",
      90,
      "copy-1",
    );
    const [original, copy] = result.sequence.tracks[0]!.clips;
    expect(copy!.startFrame).toBe(120);
    expect(copy!.parameterTracks[0]!.keyframes.map((k) => [k.frame, k.value, k.outgoing])).toEqual(
      original!.parameterTracks[0]!.keyframes.map((k) => [k.frame, k.value, k.outgoing]),
    );
    expect(copy!.parameterTracks[0]!.id).not.toBe(original!.parameterTracks[0]!.id);
    expect(copy!.id).not.toBe(original!.id);
    expect(copy!.assetId).toBe(original!.assetId);
    expect(copy!.binding).toEqual({
      sourceFile: "index.html",
      domId: "picture-copy",
      hfId: "copy-hf",
    });
    copy!.staticParameters!["layout.width"] = 999;
    expect(original!.staticParameters!["layout.width"]).toBe(100);
    expect(JSON.stringify(source)).toBe(before);
  });
  it("can paste a cut clip whose original no longer exists", () => {
    const source = fixture();
    const snapshot = captureNativeClips(source, [{ id: "picture", sourceFile: "index.html" }]);
    source.sequence.tracks[0]!.clips = [];
    const result = pasteNativeClips(
      source,
      snapshot,
      [{ domId: "pasted" }],
      "index.html",
      0,
      "cut-1",
    );
    expect(result.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes).toHaveLength(2);
  });
  it("rejects an incompatible project, missing destination track, or fractional frame delta atomically", () => {
    const source = fixture();
    const snapshot = captureNativeClips(source, [{ id: "picture", sourceFile: "index.html" }]);
    expect(() =>
      pasteNativeClips(
        { ...source, id: "other" },
        snapshot,
        [{ domId: "copy" }],
        "index.html",
        0,
        "n",
      ),
    ).toThrow();
    expect(() =>
      pasteNativeClips(source, snapshot, [{ domId: "copy" }], "index.html", 0.5, "n"),
    ).toThrow();
    source.sequence.tracks = [];
    expect(() =>
      pasteNativeClips(source, snapshot, [{ domId: "copy" }], "index.html", 0, "n"),
    ).toThrow();
  });
});
