import { describe, expect, it } from "vitest";

import { createNativeParameterTrack } from "./nativeKeyframeTypes";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { applyNativeProjectPropertyCommand } from "./nativeProjectPropertyCommands";

const project = (): NativeProjectDocument =>
  parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:property-commands",
    revision: 0,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [{ id: "asset:video", kind: "video", name: "clip.mov", durationFrames: 120 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [
        {
          id: "track:v1",
          kind: "video",
          clips: [
            {
              id: "clip:one",
              assetId: "asset:video",
              startFrame: 0,
              durationFrames: 120,
              sourceInFrame: 0,
              muted: false,
              staticParameters: {},
              effects: [],
              parameterTracks: [
                createNativeParameterTrack({
                  id: "parameter:rotation",
                  parameterId: "transform.rotation",
                  valueType: "number",
                  frameRate: { numerator: 30, denominator: 1 },
                  keyframes: [
                    { id: "key:0", frame: 0, value: 0, outgoing: { type: "linear" } },
                    {
                      id: "key:60",
                      frame: 60,
                      value: -180,
                      outgoing: { type: "hold" },
                    },
                  ],
                }),
              ],
            },
          ],
        },
      ],
    },
  });

const address = (parameterId = "transform.rotation") => ({
  sequenceId: "sequence:main",
  trackId: "track:v1",
  clipId: "clip:one",
  parameterId,
});

describe("native project property commands", () => {
  it("sets a static parameter without creating or changing keyframe tracks", () => {
    const before = project();
    const result = applyNativeProjectPropertyCommand(before, {
      type: "set-static",
      address: address("visual.opacity"),
      value: 0.5,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clip = result.document.sequence.tracks[0]!.clips[0]!;
    expect(clip.staticParameters).toEqual({ "visual.opacity": 0.5 });
    expect(clip.parameterTracks).toEqual(before.sequence.tracks[0]!.clips[0]!.parameterTracks);
    expect(before.sequence.tracks[0]!.clips[0]!.staticParameters).toEqual({});
  });

  it("offsets all numeric key values while preserving frames, ids, and interpolation", () => {
    const result = applyNativeProjectPropertyCommand(project(), {
      type: "offset-track",
      address: address(),
      delta: -30,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.sequence.tracks[0]!.clips[0]!.parameterTracks[0]!.keyframes).toEqual([
      { id: "key:0", frame: 0, value: -30, outgoing: { type: "linear" } },
      { id: "key:60", frame: 60, value: -210, outgoing: { type: "hold" } },
    ]);
  });

  it("rolls an entire mixed batch back to the original reference when any child fails", () => {
    const before = project();
    const result = applyNativeProjectPropertyCommand(before, {
      type: "batch",
      commands: [
        { type: "set-static", address: address("visual.opacity"), value: 0.5 },
        { type: "offset-track", address: address("missing.parameter"), delta: 10 },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.document).toBe(before);
    if (!result.ok) expect(result.failure.code).toBe("missing-parameter");
  });

  it("delegates exact keyframe mutations through the same atomic command boundary", () => {
    const result = applyNativeProjectPropertyCommand(project(), {
      type: "batch",
      commands: [
        {
          type: "update-value",
          address: address(),
          frame: 60,
          value: -90,
        },
        {
          type: "set-static",
          address: address("visual.opacity"),
          value: 0.75,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clip = result.document.sequence.tracks[0]!.clips[0]!;
    expect(clip.parameterTracks[0]!.keyframes[1]!.value).toBe(-90);
    expect(clip.staticParameters).toEqual({ "visual.opacity": 0.75 });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a non-finite offset %s without mutation",
    (delta) => {
      const before = project();
      const result = applyNativeProjectPropertyCommand(before, {
        type: "offset-track",
        address: address(),
        delta,
      });
      expect(result.ok).toBe(false);
      expect(result.document).toBe(before);
      if (!result.ok) expect(result.failure.code).toBe("invalid-value");
    },
  );

  it("collapses one animated parameter to its evaluated value at an exact local frame", () => {
    const before = project();
    const result = applyNativeProjectPropertyCommand(before, {
      type: "collapse-track",
      address: address(),
      frame: 30,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clip = result.document.sequence.tracks[0]!.clips[0]!;
    expect(clip.staticParameters).toEqual({ "transform.rotation": -90 });
    expect(clip.parameterTracks).toEqual([]);
    expect(before.sequence.tracks[0]!.clips[0]!.parameterTracks).toHaveLength(1);
  });

  it("removes exactly the collapsed track while preserving other tracks and static values", () => {
    const base = project();
    const originalClip = base.sequence.tracks[0]!.clips[0]!;
    const withOtherState = parseNativeProjectDocument({
      ...base,
      sequence: {
        ...base.sequence,
        tracks: [{
          ...base.sequence.tracks[0]!,
          clips: [{
            ...originalClip,
            staticParameters: { "layout.width": 640 },
            parameterTracks: [
              ...originalClip.parameterTracks,
              createNativeParameterTrack({
                id: "parameter:opacity",
                parameterId: "visual.opacity",
                valueType: "number",
                frameRate: { numerator: 30, denominator: 1 },
                keyframes: [
                  { id: "opacity:0", frame: 0, value: 1, outgoing: { type: "linear" } },
                ],
              }),
            ],
          }],
        }],
      },
    });

    const result = applyNativeProjectPropertyCommand(withOtherState, {
      type: "collapse-track",
      address: address(),
      frame: 60,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clip = result.document.sequence.tracks[0]!.clips[0]!;
    expect(clip.staticParameters).toEqual({
      "layout.width": 640,
      "transform.rotation": -180,
    });
    expect(clip.parameterTracks).toEqual([
      expect.objectContaining({ id: "parameter:opacity", parameterId: "visual.opacity" }),
    ]);
  });

  it.each([-1, 120, 1.5])(
    "rejects collapse frame %s without exposing a partial document",
    (frame) => {
      const before = project();
      const result = applyNativeProjectPropertyCommand(before, {
        type: "collapse-track",
        address: address(),
        frame,
      });

      expect(result.ok).toBe(false);
      expect(result.document).toBe(before);
      if (!result.ok) expect(result.failure.code).toBe("invalid-frame");
    },
  );

  it("rejects the wrong stable parameter address without changing static or animated state", () => {
    const before = project();
    const result = applyNativeProjectPropertyCommand(before, {
      type: "collapse-track",
      address: address("transform.missing"),
      frame: 30,
    });

    expect(result.ok).toBe(false);
    expect(result.document).toBe(before);
    if (!result.ok) expect(result.failure.code).toBe("missing-parameter");
  });
});
