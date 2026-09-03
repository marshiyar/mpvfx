import { describe, expect, it } from "vitest";

import { createNativeParameterTrack, type NativeParameterTrack } from "./nativeKeyframeTypes";
import {
  projectNativeKeyframeUi,
  type NativeKeyframeUiProjectionResult,
} from "./nativeKeyframeUiProjection";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";

const frameRate = { numerator: 30, denominator: 1 } as const;
const numberTrack = (
  id: string,
  parameterId: string,
  keyframes: NativeParameterTrack<"number">["keyframes"],
) => createNativeParameterTrack({ id, parameterId, valueType: "number", frameRate, keyframes });

const supportedTracks = (): NativeParameterTrack[] => [
  numberTrack("animation:rotation", "transform.rotation", [
    { id: "rotation:0", frame: 0, value: 0, outgoing: { type: "linear" } },
    { id: "rotation:90", frame: 90, value: -180, outgoing: { type: "hold" } },
  ]),
  numberTrack("animation:x", "transform.position.x", [
    { id: "x:0", frame: 0, value: 0, outgoing: { type: "linear" } },
    { id: "x:90", frame: 90, value: 100, outgoing: { type: "linear" } },
  ]),
  numberTrack("animation:opacity", "visual.opacity", [
    { id: "opacity:0", frame: 0, value: 1, outgoing: { type: "hold" } },
    { id: "opacity:60", frame: 60, value: 0.5, outgoing: { type: "linear" } },
  ]),
  numberTrack("animation:unsupported", "grade.temperature", [
    { id: "temperature:0", frame: 0, value: 6500, outgoing: { type: "linear" } },
  ]),
];

const makeDocument = (tracks: NativeParameterTrack[] = supportedTracks()): NativeProjectDocument =>
  parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:ui",
    revision: 0,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#111111" },
    assets: [{ id: "asset:video", kind: "video", name: "video.mov", durationFrames: 500 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [
        {
          id: "track:video",
          kind: "video",
          clips: [
            {
              id: "clip:first",
              assetId: "asset:video",
              startFrame: 30,
              durationFrames: 120,
              sourceInFrame: 0,
              muted: false,
              binding: {
                sourceFile: "scenes/main.html",
                domId: "preview-first",
                hfId: "hf-first",
                selector: "#preview-first",
                selectorIndex: 0,
              },
              effects: [],
              parameterTracks: tracks,
            },
            {
              id: "clip:second",
              assetId: "asset:video",
              startFrame: 150,
              durationFrames: 120,
              sourceInFrame: 120,
              muted: false,
              binding: {
                sourceFile: "scenes/main.html",
                domId: "preview-second",
                hfId: "hf-second",
                selector: "#preview-second",
                selectorIndex: 0,
              },
              effects: [],
              parameterTracks: [],
            },
          ],
        },
      ],
    },
  });

const expectSuccess = (
  result: NativeKeyframeUiProjectionResult,
): Extract<NativeKeyframeUiProjectionResult, { ok: true }> => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.message);
  return result;
};

describe("native keyframe UI projection", () => {
  it("returns canonical identity, clip timing, local frame, and evaluated current values", () => {
    const result = expectSuccess(
      projectNativeKeyframeUi(makeDocument(), {
        selectedElement: {
          attributes: { "data-studio-clip-id": "clip:first" },
        },
        playheadSeconds: 75 / 30,
      }),
    );

    expect(result).toMatchObject({
      sequenceId: "sequence:main",
      trackId: "track:video",
      clipId: "clip:first",
      clipStartSeconds: 1,
      clipDurationSeconds: 4,
      projectFrame: 75,
      clipLocalFrame: 45,
      currentValues: { x: 50, rotation: -90, opacity: 1 },
    });
    expect(result.currentValues).not.toHaveProperty("temperature");
  });

  it("projects navigation rows with native metadata, animation identity, percentages, and authored direction", () => {
    const result = expectSuccess(
      projectNativeKeyframeUi(makeDocument(), {
        selectedElement: { id: "clip:first" },
        playheadSeconds: 75 / 30,
      }),
    );

    expect(result.keyframeRows).toEqual([
      {
        percentage: 0,
        properties: { x: 0 },
        animationId: "animation:x",
        parameterId: "transform.position.x",
        nativeKeyframeId: "x:0",
        nativeFrame: 0,
        interpolation: { type: "linear" },
      },
      {
        percentage: 75,
        properties: { x: 100 },
        animationId: "animation:x",
        parameterId: "transform.position.x",
        nativeKeyframeId: "x:90",
        nativeFrame: 90,
        interpolation: { type: "linear" },
      },
      {
        percentage: 0,
        properties: { rotation: 0 },
        animationId: "animation:rotation",
        parameterId: "transform.rotation",
        nativeKeyframeId: "rotation:0",
        nativeFrame: 0,
        interpolation: { type: "linear" },
      },
      {
        percentage: 75,
        properties: { rotation: -180 },
        animationId: "animation:rotation",
        parameterId: "transform.rotation",
        nativeKeyframeId: "rotation:90",
        nativeFrame: 90,
        interpolation: { type: "hold" },
      },
      {
        percentage: 0,
        properties: { opacity: 1 },
        animationId: "animation:opacity",
        parameterId: "visual.opacity",
        nativeKeyframeId: "opacity:0",
        nativeFrame: 0,
        interpolation: { type: "hold" },
      },
      {
        percentage: 50,
        properties: { opacity: 0.5 },
        animationId: "animation:opacity",
        parameterId: "visual.opacity",
        nativeKeyframeId: "opacity:60",
        nativeFrame: 60,
        interpolation: { type: "linear" },
      },
    ]);
  });

  it("maps every supported native numeric parameter and omits unsupported or wrong-typed tracks", () => {
    const all = [
      ["transform.position.x", "x"],
      ["transform.position.y", "y"],
      ["transform.rotation", "rotation"],
      ["transform.scale", "scale"],
      ["transform.scaleX", "scaleX"],
      ["transform.scaleY", "scaleY"],
      ["visual.opacity", "opacity"],
      ["layout.width", "width"],
      ["layout.height", "height"],
    ] as const;
    const tracks: NativeParameterTrack[] = all.map(([parameterId], index) =>
      numberTrack(`track:${parameterId}`, parameterId, [
        { id: `key:${index}`, frame: 0, value: index + 1, outgoing: { type: "linear" } },
      ]),
    );
    tracks.push(
      createNativeParameterTrack({
        id: "wrong:x",
        parameterId: "transform.position",
        valueType: "vec2",
        frameRate,
        keyframes: [
          { id: "wrong:key", frame: 0, value: { x: 9, y: 10 }, outgoing: { type: "linear" } },
        ],
      }),
    );
    const result = expectSuccess(
      projectNativeKeyframeUi(makeDocument(tracks), {
        selectedElement: { id: "clip:first" },
        playheadSeconds: 30 / 30,
      }),
    );

    expect(result.currentValues).toEqual(
      Object.fromEntries(all.map(([, property], index) => [property, index + 1])),
    );
    expect(result.keyframeRows.map((row) => Object.keys(row.properties)[0])).toEqual(
      all.map(([, property]) => property),
    );
  });

  it("projects all exposed 3D transform controls into native UI rows and values", () => {
    const all = [
      ["transform.position.z", "z", 120],
      ["transform.rotationX", "rotationX", 12],
      ["transform.rotationY", "rotationY", -18],
      ["transform.scaleZ", "scaleZ", 0.8],
      ["transform.perspective", "transformPerspective", 900],
    ] as const;
    const tracks = all.map(([parameterId, , value], index) =>
      numberTrack(`track:3d:${index}`, parameterId, [
        { id: `key:3d:${index}`, frame: 0, value, outgoing: { type: "linear" } },
      ]),
    );
    const result = expectSuccess(
      projectNativeKeyframeUi(makeDocument(tracks), {
        selectedElement: { id: "clip:first" },
        playheadSeconds: 30 / 30,
      }),
    );

    expect(result.currentValues).toEqual(
      Object.fromEntries(all.map(([, property, value]) => [property, value])),
    );
    expect(result.keyframeRows.map((row) => Object.keys(row.properties)[0])).toEqual(
      all.map(([, property]) => property),
    );
  });

  it("orders rows deterministically by UI property then native frame regardless of document track order", () => {
    const ordered = expectSuccess(
      projectNativeKeyframeUi(makeDocument(supportedTracks()), {
        selectedElement: { id: "clip:first" },
        playheadSeconds: 75 / 30,
      }),
    );
    const reversed = expectSuccess(
      projectNativeKeyframeUi(makeDocument([...supportedTracks()].reverse()), {
        selectedElement: { id: "clip:first" },
        playheadSeconds: 75 / 30,
      }),
    );

    expect(reversed).toEqual(ordered);
  });

  it("resolves an exact scoped compatibility binding when no canonical clip id is available", () => {
    const result = expectSuccess(
      projectNativeKeyframeUi(makeDocument(), {
        selectedElement: {
          id: "preview-first",
          sourceFile: "scenes/main.html",
        },
        playheadSeconds: 75 / 30,
      }),
    );

    expect(result.clipId).toBe("clip:first");
  });

  it("surfaces scoped compatibility-binding ambiguity without projecting either clip", () => {
    const result = projectNativeKeyframeUi(makeDocument(), {
      selectedElement: {
        id: "preview-first",
        hfId: "hf-second",
        sourceFile: "scenes/main.html",
      },
      playheadSeconds: 75 / 30,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("ambiguous-clip");
  });

  it.each([-0.1, Number.NaN])("rejects invalid project playhead seconds %s", (playheadSeconds) => {
    const result = projectNativeKeyframeUi(makeDocument(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("invalid-playhead");
  });

  it("rejects a playhead outside the selected clip instead of evaluating a clamped value", () => {
    const result = projectNativeKeyframeUi(makeDocument(), {
      selectedElement: { id: "clip:first" },
      playheadSeconds: 150 / 30,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("playhead-outside-clip");
  });

  it("projects static native values without fabricating keyframe rows", () => {
    const document = makeDocument([]);
    document.sequence.tracks[0]!.clips[0]!.staticParameters = {
      "transform.position.x": 42,
      "transform.rotation": -30,
      "visual.opacity": 0.75,
      "grade.temperature": 6500,
    };

    const result = expectSuccess(
      projectNativeKeyframeUi(document, {
        selectedElement: { id: "clip:first" },
        playheadSeconds: 75 / 30,
      }),
    );

    expect(result.currentValues).toEqual({ x: 42, rotation: -30, opacity: 0.75 });
    expect(result.keyframeRows).toEqual([]);
  });

  it("lets an animated track override only its matching static base value", () => {
    const document = makeDocument([
      numberTrack("animation:rotation", "transform.rotation", [
        { id: "rotation:0", frame: 0, value: 0, outgoing: { type: "linear" } },
        { id: "rotation:90", frame: 90, value: -180, outgoing: { type: "linear" } },
      ]),
    ]);
    document.sequence.tracks[0]!.clips[0]!.staticParameters = {
      "transform.position.x": 42,
      "transform.rotation": 999,
    };

    const result = expectSuccess(
      projectNativeKeyframeUi(document, {
        selectedElement: { id: "clip:first" },
        playheadSeconds: 75 / 30,
      }),
    );

    expect(result.currentValues).toEqual({ x: 42, rotation: -90 });
  });
});
