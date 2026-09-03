import { describe, expect, it } from "vitest";

import { evaluateNativeParameterTrack } from "./nativeKeyframeEvaluator";
import { createNativeParameterTrack, type NativeParameterTrack } from "./nativeKeyframeTypes";
import {
  applyNativeProjectKeyframeCommand,
  nativeParameterKeyframeId,
  nativeParameterTrackId,
  type NativeProjectKeyframeCommand,
} from "./nativeProjectKeyframeCommands";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";

const frameRate = { numerator: 30, denominator: 1 } as const;
const address = {
  sequenceId: "sequence:main",
  trackId: "track:video",
  clipId: "clip:first",
  parameterId: "transform.rotation",
} as const;

const makeDocument = (): NativeProjectDocument =>
  parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:demo",
    revision: 7,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#101010" },
    assets: [{ id: "asset:video", kind: "video", name: "video.mov", durationFrames: 360 }],
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
              startFrame: 0,
              durationFrames: 120,
              sourceInFrame: 0,
              muted: false,
              effects: [],
              parameterTracks: [
                createNativeParameterTrack({
                  id: "parameter:first:position",
                  parameterId: "transform.position",
                  valueType: "vec2",
                  frameRate,
                  keyframes: [
                    {
                      id: "position:0",
                      frame: 0,
                      value: { x: 100, y: 200 },
                      outgoing: { type: "linear" },
                    },
                  ],
                }),
                createNativeParameterTrack({
                  id: "parameter:first:scale",
                  parameterId: "transform.scale",
                  valueType: "number",
                  frameRate,
                  keyframes: [
                    { id: "scale:0", frame: 0, value: 1, outgoing: { type: "linear" } },
                  ],
                }),
                createNativeParameterTrack({
                  id: "parameter:first:opacity",
                  parameterId: "transform.opacity",
                  valueType: "number",
                  frameRate,
                  keyframes: [
                    { id: "opacity:0", frame: 0, value: 1, outgoing: { type: "linear" } },
                  ],
                }),
              ],
            },
            {
              id: "clip:second",
              assetId: "asset:video",
              startFrame: 120,
              durationFrames: 120,
              sourceInFrame: 120,
              muted: false,
              effects: [],
              parameterTracks: [],
            },
          ],
        },
      ],
    },
  });

const expectReversible = (
  document: NativeProjectDocument,
  command: NativeProjectKeyframeCommand,
): NativeProjectDocument => {
  const result = applyNativeProjectKeyframeCommand(document, command);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.message);
  expect(result.document.revision).toBe(document.revision);
  const reverted = applyNativeProjectKeyframeCommand(result.document, result.inverse);
  expect(reverted.ok).toBe(true);
  if (!reverted.ok) throw new Error(reverted.failure.message);
  expect(serializeNativeProjectDocument(reverted.document)).toBe(
    serializeNativeProjectDocument(document),
  );
  return result.document;
};

const clipById = (document: NativeProjectDocument, clipId: string) =>
  document.sequence.tracks[0]!.clips.find((clip) => clip.id === clipId)!;

describe("native project keyframe commands", () => {
  it("creates exactly one rotation key at the requested nonzero frame", () => {
    const original = makeDocument();
    const unrelatedBefore = JSON.stringify(clipById(original, "clip:first").parameterTracks);
    const next = expectReversible(original, {
      type: "upsert",
      address,
      valueType: "number",
      frame: 90,
      value: -180,
      baselineValue: 0,
    });
    const firstClip = clipById(next, "clip:first");
    const rotation = firstClip.parameterTracks.find(
      (track) => track.parameterId === "transform.rotation",
    ) as NativeParameterTrack<"number">;

    expect(rotation.id).toBe(nativeParameterTrackId(address.clipId, address.parameterId));
    expect(rotation.keyframes.map(({ id, frame, value }) => ({ id, frame, value }))).toEqual([
      {
        id: nativeParameterKeyframeId(rotation.id, 90),
        frame: 90,
        value: -180,
      },
    ]);
    expect(evaluateNativeParameterTrack(rotation, 45)).toBe(-180);
    expect(JSON.stringify(firstClip.parameterTracks.slice(0, 3))).toBe(unrelatedBefore);
  });

  it("adds one key per explicit action and connects only adjacent authored keys", () => {
    let document = makeDocument();
    const authored = [
      { frame: 30, value: 0 },
      { frame: 60, value: 90 },
      { frame: 90, value: 180 },
    ];

    for (const [index, keyframe] of authored.entries()) {
      const result = applyNativeProjectKeyframeCommand(document, {
        type: "upsert",
        address,
        valueType: "number",
        frame: keyframe.frame,
        value: keyframe.value,
        baselineValue: -999,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.failure.message);
      document = result.document;
      const rotation = clipById(document, "clip:first").parameterTracks.find(
        (track) => track.parameterId === "transform.rotation",
      )!;
      expect(rotation.keyframes).toHaveLength(index + 1);
      expect(rotation.keyframes.map(({ frame, value }) => ({ frame, value }))).toEqual(
        authored.slice(0, index + 1),
      );
    }

    const rotation = clipById(document, "clip:first").parameterTracks.find(
      (track) => track.parameterId === "transform.rotation",
    ) as NativeParameterTrack<"number">;
    expect(evaluateNativeParameterTrack(rotation, 45)).toBe(45);
    expect(evaluateNativeParameterTrack(rotation, 75)).toBe(135);
  });

  it("creates only one key when the first destination is frame zero", () => {
    const next = expectReversible(makeDocument(), {
      type: "upsert",
      address,
      valueType: "number",
      frame: 0,
      value: -30,
      baselineValue: 0,
    });
    const rotation = clipById(next, "clip:first").parameterTracks.at(-1)!;

    expect(rotation.keyframes).toHaveLength(1);
    expect(rotation.keyframes[0]).toMatchObject({ frame: 0, value: -30 });
  });

  it("upserts an existing exact frame while preserving its key ID and unrelated parameter bytes", () => {
    const withRotation = expectReversible(makeDocument(), {
      type: "upsert",
      address,
      valueType: "number",
      frame: 90,
      value: -180,
      baselineValue: 0,
    });
    const clipBefore = clipById(withRotation, "clip:first");
    const unrelatedBefore = JSON.stringify(
      clipBefore.parameterTracks.filter((track) => track.parameterId !== "transform.rotation"),
    );
    const existing = clipBefore.parameterTracks.find(
      (track) => track.parameterId === "transform.rotation",
    )!;
    const existingId = existing.keyframes.find((keyframe) => keyframe.frame === 90)!.id;

    const next = expectReversible(withRotation, {
      type: "upsert",
      address,
      valueType: "number",
      frame: 90,
      value: -120,
      baselineValue: 999,
    });
    const clipAfter = clipById(next, "clip:first");
    const rotation = clipAfter.parameterTracks.find(
      (track) => track.parameterId === "transform.rotation",
    )!;

    expect(rotation.keyframes.find((keyframe) => keyframe.frame === 90)).toMatchObject({
      id: existingId,
      value: -120,
    });
    expect(JSON.stringify(
      clipAfter.parameterTracks.filter((track) => track.parameterId !== "transform.rotation"),
    )).toBe(unrelatedBefore);
  });

  it("editing a second clip preserves the first clip byte-for-byte", () => {
    const original = makeDocument();
    const firstBefore = JSON.stringify(clipById(original, "clip:first"));
    const next = expectReversible(original, {
      type: "upsert",
      address: { ...address, clipId: "clip:second" },
      valueType: "number",
      frame: 60,
      value: 0.5,
      baselineValue: 1,
    });

    expect(JSON.stringify(clipById(next, "clip:first"))).toBe(firstBefore);
  });

  it("updates, moves, deletes, and changes outgoing interpolation through native track commands", () => {
    let document = expectReversible(makeDocument(), {
      type: "upsert",
      address,
      valueType: "number",
      frame: 0,
      value: 0,
      baselineValue: 0,
    });
    document = expectReversible(document, {
      type: "upsert",
      address,
      valueType: "number",
      frame: 90,
      value: -180,
      baselineValue: 0,
    });
    document = expectReversible(document, {
      type: "update-value",
      address,
      frame: 90,
      value: -150,
    });
    document = expectReversible(document, {
      type: "move",
      address,
      fromFrame: 90,
      toFrame: 80,
    });
    document = expectReversible(document, {
      type: "set-outgoing",
      address,
      frame: 0,
      outgoing: { type: "hold" },
    });
    document = expectReversible(document, {
      type: "delete",
      address,
      frame: 80,
    });

    const rotation = clipById(document, "clip:first").parameterTracks.find(
      (track) => track.parameterId === "transform.rotation",
    )!;
    expect(rotation.keyframes).toEqual([
      expect.objectContaining({ frame: 0, value: 0, outgoing: { type: "hold" } }),
    ]);
  });

  it("applies a batch across independent parameters atomically and reversibly", () => {
    const original = makeDocument();
    const next = expectReversible(original, {
      type: "batch",
      commands: [
        {
          type: "upsert",
          address,
          valueType: "number",
          frame: 90,
          value: -180,
          baselineValue: 0,
        },
        {
          type: "upsert",
          address: { ...address, parameterId: "grade.tint" },
          valueType: "rgba",
          frame: 90,
          value: { red: 1, green: 0, blue: 0, alpha: 1 },
          baselineValue: { red: 0, green: 0, blue: 0, alpha: 1 },
        },
      ],
    });

    expect(
      clipById(next, "clip:first").parameterTracks.map((track) => track.parameterId),
    ).toEqual([
      "transform.position",
      "transform.scale",
      "transform.opacity",
      "transform.rotation",
      "grade.tint",
    ]);
  });

  it("rejects a mixed valid/invalid batch with the original document reference and no partial edit", () => {
    const original = makeDocument();
    const result = applyNativeProjectKeyframeCommand(original, {
      type: "batch",
      commands: [
        {
          type: "upsert",
          address,
          valueType: "number",
          frame: 30,
          value: -45,
          baselineValue: 0,
        },
        {
          type: "upsert",
          address: { ...address, clipId: "missing" },
          valueType: "number",
          frame: 30,
          value: 1,
          baselineValue: 0,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.document).toBe(original);
    if (!result.ok) expect(result.failure.code).toBe("missing-clip");
    expect(serializeNativeProjectDocument(original)).toBe(
      serializeNativeProjectDocument(makeDocument()),
    );
  });

  it.each([-1, 120, 1.5])("rejects clip-local frame %s outside the exact editable range", (frame) => {
    const original = makeDocument();
    const result = applyNativeProjectKeyframeCommand(original, {
      type: "upsert",
      address,
      valueType: "number",
      frame,
      value: 10,
      baselineValue: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.document).toBe(original);
    if (!result.ok) expect(result.failure.code).toBe("invalid-frame");
  });

  it("rejects a mismatched value type without touching the existing parameter", () => {
    const original = makeDocument();
    const result = applyNativeProjectKeyframeCommand(original, {
      type: "upsert",
      address: { ...address, parameterId: "transform.position" },
      valueType: "number",
      frame: 30,
      value: 10,
      baselineValue: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.document).toBe(original);
    if (!result.ok) expect(result.failure.code).toBe("value-type-mismatch");
  });

  it("rejects an update value whose runtime shape does not match the existing track", () => {
    const original = makeDocument();
    const result = applyNativeProjectKeyframeCommand(original, {
      type: "update-value",
      address: { ...address, parameterId: "transform.position" },
      frame: 0,
      value: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.document).toBe(original);
    if (!result.ok) expect(result.failure.code).toBe("value-type-mismatch");
  });

  it("reports invalid interpolation distinctly without modifying the document", () => {
    const original = makeDocument();
    const result = applyNativeProjectKeyframeCommand(original, {
      type: "upsert",
      address,
      valueType: "number",
      frame: 90,
      value: -180,
      baselineValue: 0,
      outgoing: {
        type: "cubic-bezier",
        controlPoints: { x1: -1, y1: 0, x2: 1, y2: 1 },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.document).toBe(original);
    if (!result.ok) expect(result.failure.code).toBe("invalid-interpolation");
  });

  it("rejects parameter-track frame-rate drift from the project contract", () => {
    const original = makeDocument();
    const clip = clipById(original, "clip:first");
    const badDocument = {
      ...original,
      sequence: {
        ...original.sequence,
        tracks: original.sequence.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((candidate) =>
            candidate.id === clip.id
              ? {
                  ...candidate,
                  parameterTracks: candidate.parameterTracks.map((parameterTrack) =>
                    parameterTrack.parameterId === "transform.opacity"
                      ? { ...parameterTrack, frameRate: { numerator: 24, denominator: 1 } }
                      : parameterTrack,
                  ),
                }
              : candidate,
          ),
        })),
      },
    } as NativeProjectDocument;
    const result = applyNativeProjectKeyframeCommand(badDocument, {
      type: "update-value",
      address: { ...address, parameterId: "transform.opacity" },
      frame: 0,
      value: 0.5,
    });

    expect(result.ok).toBe(false);
    expect(result.document).toBe(badDocument);
    if (!result.ok) expect(result.failure.code).toBe("frame-rate-mismatch");
  });

  it("derives the same IDs for the same stable address on independent documents", () => {
    const command: NativeProjectKeyframeCommand = {
      type: "upsert",
      address,
      valueType: "number",
      frame: 90,
      value: -180,
      baselineValue: 0,
    };
    const left = applyNativeProjectKeyframeCommand(makeDocument(), command);
    const right = applyNativeProjectKeyframeCommand(makeDocument(), command);
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;

    expect(serializeNativeProjectDocument(left.document)).toBe(
      serializeNativeProjectDocument(right.document),
    );
  });

  it("moves multiple exact-frame keyframes as one atomic ordered group", () => {
    let document = expectReversible(makeDocument(), {
      type: "upsert",
      address,
      valueType: "number",
      frame: 0,
      value: 0,
      baselineValue: 0,
    });
    document = expectReversible(document, {
      type: "upsert",
      address,
      valueType: "number",
      frame: 30,
      value: -90,
      baselineValue: 0,
    });
    document = expectReversible(document, {
      type: "upsert",
      address,
      valueType: "number",
      frame: 60,
      value: -180,
      baselineValue: 0,
    });

    const moved = expectReversible(document, {
      type: "move-many",
      address,
      frames: [30, 60],
      deltaFrames: 5,
    });
    const rotation = clipById(moved, "clip:first").parameterTracks.find(
      (track) => track.parameterId === "transform.rotation",
    )!;
    expect(rotation.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 35, 65]);
  });

  it("deletes multiple exact-frame keyframes atomically and reversibly", () => {
    let document = expectReversible(makeDocument(), {
      type: "upsert",
      address,
      valueType: "number",
      frame: 0,
      value: 0,
      baselineValue: 0,
    });
    document = expectReversible(document, {
      type: "upsert",
      address,
      valueType: "number",
      frame: 30,
      value: -90,
      baselineValue: 0,
    });
    document = expectReversible(document, {
      type: "upsert",
      address,
      valueType: "number",
      frame: 60,
      value: -180,
      baselineValue: 0,
    });

    const deleted = expectReversible(document, {
      type: "delete-many",
      address,
      frames: [60, 30],
    });
    const rotation = clipById(deleted, "clip:first").parameterTracks.find(
      (track) => track.parameterId === "transform.rotation",
    )!;
    expect(rotation.keyframes.map((keyframe) => keyframe.frame)).toEqual([0]);
  });

  it("rejects an invalid or colliding multi-move with the original document untouched", () => {
    let document = expectReversible(makeDocument(), {
      type: "upsert",
      address,
      valueType: "number",
      frame: 0,
      value: 0,
      baselineValue: 0,
    });
    document = expectReversible(document, {
      type: "upsert",
      address,
      valueType: "number",
      frame: 30,
      value: -90,
      baselineValue: 0,
    });
    document = expectReversible(document, {
      type: "upsert",
      address,
      valueType: "number",
      frame: 60,
      value: -180,
      baselineValue: 0,
    });

    const collision = applyNativeProjectKeyframeCommand(document, {
      type: "move-many",
      address,
      frames: [0, 30],
      deltaFrames: 30,
    });
    const invalid = applyNativeProjectKeyframeCommand(document, {
      type: "move-many",
      address,
      frames: [0, 999],
      deltaFrames: 1,
    });

    expect(collision.ok).toBe(false);
    expect(collision.document).toBe(document);
    if (!collision.ok) expect(collision.failure.code).toBe("frame-collision");
    expect(invalid.ok).toBe(false);
    expect(invalid.document).toBe(document);
    if (!invalid.ok) expect(invalid.failure.code).toBe("invalid-frame");
  });

  it("rejects a mixed existing/missing multi-delete without deleting any keyframe", () => {
    let document = expectReversible(makeDocument(), {
      type: "upsert",
      address,
      valueType: "number",
      frame: 0,
      value: 0,
      baselineValue: 0,
    });
    document = expectReversible(document, {
      type: "upsert",
      address,
      valueType: "number",
      frame: 30,
      value: -90,
      baselineValue: 0,
    });
    const result = applyNativeProjectKeyframeCommand(document, {
      type: "delete-many",
      address,
      frames: [0, 15],
    });

    expect(result.ok).toBe(false);
    expect(result.document).toBe(document);
    if (!result.ok) expect(result.failure.code).toBe("missing-keyframe");
    expect(
      clipById(document, "clip:first").parameterTracks.find(
        (track) => track.parameterId === "transform.rotation",
      )!.keyframes,
    ).toHaveLength(2);
  });
});
