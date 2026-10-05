// @vitest-environment happy-dom

import { expect, it } from "vitest";
import { createNativeParameterTrack } from "../../../shared/project/nativeKeyframeTypes";
import { parseNativeProjectDocument, serializeNativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { applyNativeProjectClipCommand, nativeSplitClipId } from "../../../shared/project/nativeProjectClipCommands";
import { applyNativeFrameToDocument } from "./nativeFrameApplication";

it("keeps the visible crop pose at every frame through a native split", () => {
  const rate = { numerator: 30, denominator: 1 };
  const numeric = (id: string, first: number, last: number) => createNativeParameterTrack({
    id, parameterId: id, valueType: "number", frameRate: rate,
    keyframes: [
      { id: `${id}:first`, frame: 0, value: first, outgoing: { type: "linear" } },
      { id: `${id}:last`, frame: 90, value: last, outgoing: { type: "linear" } },
    ],
  });
  const original = parseNativeProjectDocument({
    schemaVersion: 1, id: "project", revision: 0, frameRate: rate,
    canvas: { width: 200, height: 100, background: "black" },
    assets: [{ id: "asset", kind: "element", name: "shape", durationFrames: 91 }],
    sequence: { id: "sequence", name: "Main", tracks: [{ id: "track", kind: "video", clips: [{
      id: "clip", assetId: "asset", startFrame: 0, durationFrames: 91, sourceInFrame: 0,
      muted: false, effects: [],
      parameterTracks: [
        numeric("transform.position.x", 0, 0),
        numeric("transform.position.y", 0, -20),
        numeric("transform.rotation", 0, 90),
      ],
      cropPivotSegments: [{
        startRotationKeyId: "transform.rotation:first",
        endRotationKeyId: "transform.rotation:last",
        offsetFraction: { x: 0.05, y: -0.1 },
      }],
    }] }] },
  });
  const element = document.createElement("div");
  element.style.cssText = "width: 200px; height: 100px; clip-path: inset(10px 20px 30px 40px)";
  document.body.replaceChildren(element);
  const originalClip = original.sequence.tracks[0]!.clips[0]!;
  const render = (clip: typeof originalClip, projectFrame: number) => {
    element.setAttribute("data-studio-clip-id", clip.id);
    applyNativeFrameToDocument(document, [{
      clipId: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames,
      staticParameters: clip.staticParameters, parameterTracks: clip.parameterTracks,
      cropPivotSegments: clip.cropPivotSegments,
    }], projectFrame);
    return element.style.transform;
  };
  const before = new Map([0, 15, 30, 45, 59, 60, 75, 90].map(frame => [frame, render(originalClip, frame)]));
  const result = applyNativeProjectClipCommand(original, {
    type: "split", address: { sequenceId: "sequence", trackId: "track", clipId: "clip" }, splitFrame: 60,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const clips = result.document.sequence.tracks[0]!.clips;
  const left = clips.find(clip => clip.id === "clip")!;
  const right = clips.find(clip => clip.id === nativeSplitClipId("clip", 60))!;
  for (const frame of before.keys()) {
    expect(render(frame < 60 ? left : right, frame)).toBe(before.get(frame));
  }
  const nested = applyNativeProjectClipCommand(result.document, {
    type: "split", address: { sequenceId: "sequence", trackId: "track", clipId: right.id }, splitFrame: 75,
  });
  expect(nested.ok).toBe(true);
  if (nested.ok) {
    const nestedRight = nested.document.sequence.tracks[0]!.clips.find(
      (clip) => clip.id === nativeSplitClipId(right.id, 75),
    )!;
    for (const frame of [75, 90]) expect(render(nestedRight, frame)).toBe(before.get(frame));
  }
  const reopened = parseNativeProjectDocument(JSON.parse(serializeNativeProjectDocument(result.document)));
  const reopenedClips = reopened.sequence.tracks[0]!.clips;
  for (const frame of before.keys()) {
    const clip = reopenedClips.find((item) => item.id === (frame < 60 ? "clip" : right.id))!;
    expect(render(clip, frame)).toBe(before.get(frame));
  }
  const trimIn = applyNativeProjectClipCommand(original, {
    type: "trim-in", address: { sequenceId: "sequence", trackId: "track", clipId: "clip" }, startFrame: 30,
  });
  expect(trimIn.ok).toBe(true);
  if (trimIn.ok) {
    const trimmed = trimIn.document.sequence.tracks[0]!.clips[0]!;
    for (const frame of [30, 45, 59, 60, 75, 90]) {
      expect(render(trimmed, frame)).toBe(before.get(frame));
    }
  }
  const trimOut = applyNativeProjectClipCommand(original, {
    type: "trim-out", address: { sequenceId: "sequence", trackId: "track", clipId: "clip" }, endFrameExclusive: 60,
  });
  expect(trimOut.ok).toBe(true);
  if (trimOut.ok) {
    const trimmed = trimOut.document.sequence.tracks[0]!.clips[0]!;
    for (const frame of [0, 15, 30, 45, 59]) {
      expect(render(trimmed, frame)).toBe(before.get(frame));
    }
  }
});
