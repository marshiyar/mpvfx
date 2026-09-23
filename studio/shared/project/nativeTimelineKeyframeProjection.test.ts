import { describe, expect, it } from "vitest";

import { createNativeParameterTrack, type NativeParameterTrack } from "./nativeKeyframeTypes";
import {
  projectNativeTimelineKeyframes,
  type NativeTimelineKeyframeProjectionResult,
} from "./nativeTimelineKeyframeProjection";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";

const frameRate = { numerator: 30, denominator: 1 } as const;
const numericTrack = (
  id: string,
  parameterId: string,
  values: readonly [id: string, frame: number, value: number][],
): NativeParameterTrack<"number"> =>
  createNativeParameterTrack({
    id,
    parameterId,
    valueType: "number",
    frameRate,
    keyframes: values.map(([keyframeId, frame, value], index) => ({
      id: keyframeId,
      frame,
      value,
      outgoing:
        index === 0
          ? {
              type: "cubic-bezier" as const,
              controlPoints: { x1: 0.42, y1: 0, x2: 1, y2: 1 },
            }
          : { type: "hold" as const },
    })),
  });

const tracks = (): NativeParameterTrack[] => [
  numericTrack("animation:rotation", "transform.rotation", [
    ["rotation:0", 0, 0],
    ["rotation:90", 90, -180],
  ]),
  numericTrack("animation:y", "transform.position.y", [
    ["y:0", 0, 0],
    ["y:60", 60, 80],
  ]),
  numericTrack("animation:scaleY", "transform.scaleY", [["scale-y:0", 0, 1]]),
  numericTrack("animation:x", "transform.position.x", [
    ["x:0", 0, 0],
    ["x:30", 30, 100],
  ]),
  numericTrack("animation:opacity", "visual.opacity", [["opacity:0", 0, 1]]),
  numericTrack("animation:width", "layout.width", [["width:0", 0, 640]]),
  numericTrack("animation:unsupported", "grade.temperature", [["temperature:0", 0, 6500]]),
];

const documentFixture = (parameterTracks = tracks()): NativeProjectDocument =>
  parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:timeline-projection",
    revision: 0,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#111111" },
    assets: [{ id: "asset:video", kind: "video", name: "video.mov", durationFrames: 400 }],
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
              parameterTracks,
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
  result: NativeTimelineKeyframeProjectionResult,
): Extract<NativeTimelineKeyframeProjectionResult, { ok: true }> => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.message);
  return result;
};

describe("native timeline keyframe projection", () => {
  it("groups lanes into stable professional property groups and omits unsupported parameters", () => {
    const result = expectSuccess(
      projectNativeTimelineKeyframes(documentFixture(), {
        attributes: { "data-studio-clip-id": "clip:first" },
      }),
    );

    expect(result).toMatchObject({
      sequenceId: "sequence:main",
      trackId: "track:video",
      clipId: "clip:first",
      clipStartFrame: 30,
      clipDurationFrames: 120,
    });
    expect(result.groups.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "position", label: "Position" },
      { id: "rotation", label: "Rotation" },
      { id: "scale", label: "Scale" },
      { id: "opacity", label: "Opacity" },
      { id: "size", label: "Size" },
    ]);
    expect(result.groups.map((group) => group.lanes.map((lane) => lane.property))).toEqual([
      ["x", "y"],
      ["rotation"],
      ["scaleY"],
      ["opacity"],
      ["width"],
    ]);
    expect(result.groups.flatMap((group) => group.lanes)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ parameterId: "grade.temperature" })]),
    );
  });

  it("projects stable native diamonds with integer-frame percentages and authored interpolation", () => {
    const result = expectSuccess(
      projectNativeTimelineKeyframes(documentFixture(), { id: "clip:first" }),
    );
    const rotationLane = result.groups
      .find((group) => group.id === "rotation")!
      .lanes[0]!;

    expect(rotationLane).toMatchObject({
      laneId: "animation:rotation",
      animationId: "animation:rotation",
      parameterId: "transform.rotation",
      property: "rotation",
      label: "Rotation",
    });
    expect(rotationLane.diamonds).toEqual([
      {
        id: "rotation:0",
        keyframeId: "rotation:0",
        animationId: "animation:rotation",
        parameterId: "transform.rotation",
        frame: 0,
        percentage: 0,
        value: 0,
        interpolation: {
          type: "cubic-bezier",
          controlPoints: { x1: 0.42, y1: 0, x2: 1, y2: 1 },
        },
      },
      {
        id: "rotation:90",
        keyframeId: "rotation:90",
        animationId: "animation:rotation",
        parameterId: "transform.rotation",
        frame: 90,
        percentage: 75,
        value: -180,
        interpolation: { type: "hold" },
      },
    ]);
  });

  it("projects native 3D transform lanes with stable groups and labels", () => {
    const result = expectSuccess(
      projectNativeTimelineKeyframes(
        documentFixture([
          numericTrack("animation:z", "transform.position.z", [["z:0", 0, 120]]),
          numericTrack("animation:rx", "transform.rotationX", [["rx:0", 0, 12]]),
          numericTrack("animation:ry", "transform.rotationY", [["ry:0", 0, -18]]),
          numericTrack("animation:perspective", "transform.perspective", [["p:0", 0, 900]]),
          numericTrack("animation:scaleZ", "transform.scaleZ", [["sz:0", 0, 0.8]]),
        ]),
        { id: "clip:first" },
      ),
    );

    expect(result.groups.map(({ id, lanes }) => [id, lanes.map(({ property, label }) => ({ property, label }))])).toEqual([
      ["position", [{ property: "z", label: "Z" }]],
      ["rotation", [
        { property: "rotationX", label: "Rotate X" },
        { property: "rotationY", label: "Rotate Y" },
        { property: "transformPerspective", label: "Perspective" },
      ]],
      ["scale", [{ property: "scaleZ", label: "Scale Z" }]],
    ]);
  });

  it("is deterministic when native parameter tracks arrive in a different array order", () => {
    const normal = expectSuccess(
      projectNativeTimelineKeyframes(documentFixture(tracks()), { id: "clip:first" }),
    );
    const reversed = expectSuccess(
      projectNativeTimelineKeyframes(documentFixture([...tracks()].reverse()), { id: "clip:first" }),
    );

    expect(reversed).toEqual(normal);
  });

  it("resolves exact source-scoped timeline binding identity", () => {
    const result = expectSuccess(
      projectNativeTimelineKeyframes(documentFixture(), {
        id: "preview-first",
        sourceFile: "scenes/main.html",
      }),
    );

    expect(result.clipId).toBe("clip:first");
  });

  it("rejects compatibility identity that ambiguously targets two scoped clips", () => {
    const result = projectNativeTimelineKeyframes(documentFixture(), {
      id: "preview-first",
      hfId: "hf-second",
      sourceFile: "scenes/main.html",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("ambiguous-clip");
  });

  it("returns an empty group list for a resolved clip with no supported native tracks", () => {
    const result = expectSuccess(
      projectNativeTimelineKeyframes(documentFixture(), {
        attributes: { "data-studio-clip-id": "clip:second" },
      }),
    );

    expect(result.groups).toEqual([]);
  });

  it("fails structurally when a keyframe lies outside the clip-local frame range", () => {
    const invalidTrack = numericTrack("animation:late", "transform.rotation", [
      ["late:key", 120, -180],
    ]);
    const result = projectNativeTimelineKeyframes(documentFixture([invalidTrack]), {
      id: "clip:first",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toMatchObject({
        code: "keyframe-outside-clip",
        parameterId: "transform.rotation",
        keyframeId: "late:key",
      });
    }
  });
});
