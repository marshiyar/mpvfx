import { describe, expect, it } from "vitest";
import { applyNativeProjectClipCommand } from "./nativeProjectClipCommands";
import {
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { createNativeParameterTrack } from "./nativeKeyframeTypes";
import { evaluateNativeParameterTrack } from "./nativeKeyframeEvaluator";

const address = { sequenceId: "sequence", trackId: "track", clipId: "clip" };
const fps = { numerator: 30000, denominator: 1001 };
const parameters = [
  "transform.position.x",
  "transform.position.y",
  "transform.position.z",
  "transform.rotation",
  "transform.rotationX",
  "transform.rotationY",
  "transform.perspective",
  "transform.scale",
  "transform.scaleX",
  "transform.scaleY",
  "transform.scaleZ",
  "visual.opacity",
  "layout.width",
  "layout.height",
  "audio.volume",
  "effect.blur",
];
function fixture(kind: "video" | "audio" | "image"): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: 1,
    id: "project",
    revision: 0,
    frameRate: fps,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [{ id: "asset", kind, name: "media", durationFrames: 600 }],
    sequence: {
      id: "sequence",
      name: "Main",
      tracks: [
        {
          id: "track",
          kind: "mixed",
          clips: [
            {
              id: "clip",
              assetId: "asset",
              startFrame: 30,
              durationFrames: 120,
              sourceInFrame: 30,
              muted: false,
              effects: [],
              parameterTracks: parameters.map((parameterId, i) =>
                createNativeParameterTrack({
                  id: `parameter-${i}`,
                  parameterId,
                  valueType: "number",
                  frameRate: fps,
                  keyframes: [
                    {
                      id: "a",
                      frame: 0,
                      value: 0,
                      outgoing: {
                        type: "cubic-bezier",
                        controlPoints: { x1: 0.25, y1: -0.4, x2: 0.7, y2: 1.4 },
                      },
                    },
                    {
                      id: "b",
                      frame: 80,
                      value: 1,
                      outgoing: { type: "hold" },
                    },
                    {
                      id: "c",
                      frame: 110,
                      value: 0.5,
                      outgoing: { type: "linear" },
                    },
                  ],
                }),
              ),
            },
          ],
        },
      ],
    },
  });
}
const clip = (document: NativeProjectDocument) => document.sequence.tracks[0]!.clips[0]!;
function edit(
  document: NativeProjectDocument,
  command: Parameters<typeof applyNativeProjectClipCommand>[1],
) {
  const result = applyNativeProjectClipCommand(document, command);
  if (!result.ok) throw new Error(result.failure.message);
  return result;
}

describe("non-destructive timeline animation handles", () => {
  it.each(["video", "audio", "image"] as const)(
    "restores every authored %s curve after trimming and extending either edge, including after reopen",
    (kind) => {
      const original = fixture(kind);
      const trimmedIn = edit(original, {
        type: "trim-in",
        address,
        startFrame: 67,
      }).document;
      const trimmed = edit(trimmedIn, {
        type: "trim-out",
        address,
        endFrameExclusive: 92,
      }).document;
      const reopened = parseNativeProjectDocument(
        JSON.parse(serializeNativeProjectDocument(trimmed)),
      );
      const extendedIn = edit(reopened, {
        type: "trim-in",
        address,
        startFrame: 30,
      }).document;
      const restored = edit(extendedIn, {
        type: "trim-out",
        address,
        endFrameExclusive: 150,
      }).document;
      expect(clip(restored)).toEqual(clip(original));
    },
  );

  it.each(["video", "audio", "image"] as const)(
    "splits %s without deleting authored keys or changing any curve sample",
    (kind) => {
      const original = fixture(kind);
      const result = edit(original, { type: "split", address, splitFrame: 67 });
      const [left, right] = result.document.sequence.tracks[0]!.clips;
      expect(left!.parameterTracks).toEqual(clip(original).parameterTracks);
      for (let p = 0; p < parameters.length; p++) {
        const source = clip(original).parameterTracks[p]!;
        const child = right!.parameterTracks[p]!;
        expect(child.keyframes.map((k) => ({ ...k, frame: k.frame + 37 }))).toEqual(
          source.keyframes,
        );
        expect(child.keyframes).toHaveLength(source.keyframes.length);
        for (let frame = 0; frame < right!.durationFrames; frame++) {
          expect(evaluateNativeParameterTrack(child, frame)).toEqual(
            evaluateNativeParameterTrack(source, frame + 37),
          );
        }
      }
      expect(right!.sourceInFrame).toBe(kind === "image" ? 30 : 67);
      expect(edit(result.document, result.inverse).document).toEqual(original);
      expect(clip(original).durationFrames).toBe(120);
    },
  );

  it("retains both sets of handles through repeated splits and independent child edits", () => {
    const original = fixture("video");
    const first = edit(original, {
      type: "split",
      address,
      splitFrame: 67,
    }).document;
    const right = first.sequence.tracks[0]!.clips[1]!;
    const second = edit(first, {
      type: "split",
      address: { ...address, clipId: right.id },
      splitFrame: 94,
    }).document;
    const tail = second.sequence.tracks[0]!.clips[2]!;
    const extended = edit(second, {
      type: "trim-in",
      address: { ...address, clipId: tail.id },
      startFrame: 30,
    }).document;
    expect(extended.sequence.tracks[0]!.clips[2]!.parameterTracks[0]!.keyframes).toEqual(
      clip(original).parameterTracks[0]!.keyframes,
    );
    expect(second.sequence.tracks[0]!.clips[0]).toEqual(first.sequence.tracks[0]!.clips[0]);
  });
});
