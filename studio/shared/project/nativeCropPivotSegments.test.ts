import { describe, expect, it } from "vitest";
import { createNativeParameterTrack } from "./nativeKeyframeTypes";
import { parseNativeProjectDocument } from "./nativeProjectDocument";
import type { NativeProjectClip } from "./nativeProjectDocumentTypes";
import {
  currentNativeCropPivotReferences,
  markNativeCropPivotIntervals,
  rebaseNativeCropPivotSegments,
  remapNativeCropPivotKeyIds,
  validNativeCropPivotSegments,
} from "./nativeCropPivotSegments";

const rotation = (points: readonly (readonly [string, number])[]) => createNativeParameterTrack({
  id: "rotation", parameterId: "transform.rotation", valueType: "number",
  frameRate: { numerator: 30, denominator: 1 },
  keyframes: points.map(([id, frame]) => ({ id, frame, value: frame,
    outgoing: { type: "linear" as const } })),
});
const marker = { startRotationKeyId: "a", endRotationKeyId: "b",
  offsetFraction: { x: 0.05, y: -0.1 } };
const clip = { durationFrames: 91, parameterTracks: [rotation([["a", 0], ["b", 90]])],
  cropPivotSegments: [marker] } as NativeProjectClip;
const reference = { frameOffset: 0, durationFrames: 91,
  startRotationKeyId: "a", endRotationKeyId: "b",
  parameterTracks: clip.parameterTracks, staticParameters: undefined };

describe("crop pivot metadata lifecycle", () => {
  it("replaces an older marked interval when a new rotation key splits it", () => {
    const document = parseNativeProjectDocument({
      schemaVersion: 1, id: "project", revision: 0,
      frameRate: { numerator: 30, denominator: 1 },
      canvas: { width: 200, height: 100, background: "black" },
      assets: [{ id: "asset", kind: "element", name: "shape", durationFrames: 91 }],
      sequence: { id: "sequence", name: "Main", tracks: [{ id: "track", kind: "video", clips: [{
        id: "clip", assetId: "asset", startFrame: 0, durationFrames: 91, sourceInFrame: 0,
        muted: false, effects: [],
        parameterTracks: [rotation([["a", 0], ["middle", 45], ["b", 90]])],
        cropPivotSegments: [marker],
      }] }] },
    });
    const updated = markNativeCropPivotIntervals(document, "clip", 45, { x: 0.1, y: 0 });
    expect(updated.sequence.tracks[0]!.clips[0]!.cropPivotSegments).toEqual([
      { startRotationKeyId: "a", endRotationKeyId: "middle", offsetFraction: { x: 0.1, y: 0 } },
      { startRotationKeyId: "middle", endRotationKeyId: "b", offsetFraction: { x: 0.1, y: 0 } },
    ]);
    expect(document.sequence.tracks[0]!.clips[0]!.cropPivotSegments).toEqual([marker]);
  });

  it("maps a marked rotation interval onto generated trim and split boundary keys", () => {
    expect(rebaseNativeCropPivotSegments(clip, [rotation([["a", 0], ["cut-left", 59]])], 0, 60))
      .toEqual([{ ...marker, endRotationKeyId: "cut-left", reference }]);
    expect(rebaseNativeCropPivotSegments(clip, [rotation([["cut-right", 0], ["b", 30]])], 60, 91))
      .toEqual([{ ...marker, startRotationKeyId: "cut-right", reference: {
        ...reference, frameOffset: 60,
      } }]);
    expect(rebaseNativeCropPivotSegments(clip, [rotation([["b", 0]])], 90, 91)).toEqual([]);
  });

  it("remaps clipboard key IDs and retires metadata when a rotation key is deleted", () => {
    expect(remapNativeCropPivotKeyIds([marker], new Map([["a", "copy-a"], ["b", "copy-b"]])))
      .toEqual([{ ...marker, startRotationKeyId: "copy-a", endRotationKeyId: "copy-b" }]);
    expect(remapNativeCropPivotKeyIds([{ ...marker, reference }],
      new Map([["a", "copy-a"], ["b", "copy-b"]])))
      .toEqual([{ ...marker, startRotationKeyId: "copy-a", endRotationKeyId: "copy-b", reference }]);
    expect(validNativeCropPivotSegments([marker], [rotation([["a", 0]])])).toEqual([]);
    expect(validNativeCropPivotSegments([marker], [rotation([["b", 0], ["a", 90]])])).toEqual([]);
  });

  it("retires a sliced interpolation snapshot when geometry is edited", () => {
    const sliced = [{ ...marker, reference }];
    expect(currentNativeCropPivotReferences(sliced, clip.parameterTracks, clip.parameterTracks))
      .toEqual(sliced);
    expect(currentNativeCropPivotReferences(sliced, clip.parameterTracks,
      [rotation([["a", 0], ["b", 80]])])).toEqual([marker]);
  });
});
