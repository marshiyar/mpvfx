import { describe, expect, it } from "vitest";
import { captureNativeKeyframes, pasteNativeKeyframes } from "./nativeKeyframeClipboard";
import { parseNativeProjectDocument } from "./nativeProjectDocument";
const frameRate = { numerator: 30, denominator: 1 };
const address = {
  sequenceId: "s",
  trackId: "t",
  clipId: "a",
  parameterId: "transform.rotation",
};
const fixture = () =>
  parseNativeProjectDocument({
    schemaVersion: 1,
    id: "p",
    revision: 0,
    frameRate,
    canvas: { width: 100, height: 100, background: "#000000" },
    assets: [{ id: "asset", kind: "image", name: "img", durationFrames: 1 }],
    sequence: {
      id: "s",
      name: "Main",
      tracks: [
        {
          id: "t",
          kind: "video",
          clips: [
            {
              id: "a",
              assetId: "asset",
              startFrame: 30,
              durationFrames: 90,
              sourceInFrame: 0,
              muted: false,
              effects: [],
              parameterTracks: [
                {
                  schemaVersion: 1,
                  id: "r",
                  parameterId: "transform.rotation",
                  valueType: "number",
                  frameRate,
                  keyframes: [
                    {
                      id: "one",
                      frame: 10,
                      value: 12,
                      outgoing: {
                        type: "cubic-bezier",
                        controlPoints: { x1: 0.2, y1: -0.4, x2: 0.6, y2: 1 },
                      },
                    },
                    {
                      id: "two",
                      frame: 60,
                      value: 80,
                      outgoing: { type: "hold" },
                    },
                  ],
                },
              ],
            },
            {
              id: "b",
              assetId: "asset",
              startFrame: 150,
              durationFrames: 20,
              sourceInFrame: 0,
              muted: false,
              effects: [],
              parameterTracks: [],
            },
          ],
        },
      ],
    },
  });
describe("native keyframe clipboard", () => {
  it("anchors the earliest key to the playhead, preserves intervals and easing, and retains pasted keys beyond the visible Out", () => {
    const document = fixture();
    const snapshot = captureNativeKeyframes(document, [
      { address, frame: 10 },
      { address, frame: 60 },
    ]);
    const result = pasteNativeKeyframes(
      document,
      snapshot,
      { ...address, clipId: "b" },
      155,
      "copy",
    );
    const track = result.document.sequence.tracks[0]!.clips[1]!.parameterTracks[0]!;
    expect(track.keyframes.map((k) => [k.frame, k.value])).toEqual([
      [5, 12],
      [55, 80],
    ]);
    expect(track.keyframes[0]!.outgoing).toEqual(
      document.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes[0]!.outgoing,
    );
    expect(result.selection.map((k) => k.frame)).toEqual([5, 55]);
    expect(document.sequence.tracks[0]!.clips[1]!.parameterTracks).toEqual([]);
  });
  it("rejects occupied destination frames instead of overwriting unrelated keys", () => {
    const document = fixture();
    const snapshot = captureNativeKeyframes(document, [{ address, frame: 10 }]);
    expect(() => pasteNativeKeyframes(document, snapshot, address, 40, "collision")).toThrow(
      /occupied/i,
    );
  });
  it("rejects stale key identities and preserves the prior document", () => {
    const document = fixture();
    expect(() => captureNativeKeyframes(document, [{ address, frame: 11 }])).toThrow();
    expect(document.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes).toHaveLength(2);
  });
  it("rejects a different frame rate rather than silently changing animation timing", () => {
    const document = fixture();
    const snapshot = captureNativeKeyframes(document, [{ address, frame: 10 }]);
    expect(() =>
      pasteNativeKeyframes(
        { ...document, frameRate: { numerator: 25, denominator: 1 } },
        snapshot,
        address,
        50,
        "fps",
      ),
    ).toThrow(/frame rate/i);
  });
  it("rejects visual keys on an audio-only clip without changing the destination", () => {
    const document = fixture();
    const snapshot = captureNativeKeyframes(document, [{ address, frame: 10 }]);
    document.assets.push({ id: "audio", kind: "audio", name: "sound", durationFrames: 900 });
    document.sequence.tracks[0]!.kind = "mixed";
    document.sequence.tracks[0]!.clips[1]!.assetId = "audio";
    const before = JSON.stringify(document);
    expect(() => pasteNativeKeyframes(document, snapshot, { ...address, clipId: "b" }, 155, "audio"))
      .toThrow(/compatible|visual|audio/i);
    expect(JSON.stringify(document)).toBe(before);
  });
});
