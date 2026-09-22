import { describe, expect, it } from "vitest";

import { evaluateNativeParameterTrack } from "./nativeKeyframeEvaluator";
import { createNativeParameterTrack } from "./nativeKeyframeTypes";
import {
  applyNativeProjectClipCommand,
  nativeSplitClipId,
  type NativeProjectClipCommand,
} from "./nativeProjectClipCommands";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";

const frameRate = { numerator: 30, denominator: 1 } as const;
const firstAddress = {
  sequenceId: "sequence:main",
  trackId: "track:v1",
  clipId: "clip:first",
} as const;

const documentFixture = (): NativeProjectDocument =>
  parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:move",
    revision: 4,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#111111" },
    assets: [
      { id: "asset:video", kind: "video", name: "video.mov", durationFrames: 900 },
      { id: "asset:audio", kind: "audio", name: "audio.wav", durationFrames: 900 },
    ],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [
        {
          id: "track:v1",
          kind: "video",
          lane: { authoredTrack: 7, displayTrack: 1 },
          clips: [
            {
              id: "clip:first",
              assetId: "asset:video",
              startFrame: 0,
              durationFrames: 120,
              sourceInFrame: 12,
              muted: false,
              staticParameters: { "transform.rotation": 12 },
              effects: [{ id: "effect:grade", effectId: "grade", enabled: true, parameters: { lift: 0.1 } }],
              parameterTracks: [
                createNativeParameterTrack({
                  id: "parameter:first:rotation",
                  parameterId: "transform.rotation",
                  valueType: "number",
                  frameRate,
                  keyframes: [
                    { id: "rotation:0", frame: 0, value: 0, outgoing: { type: "linear" } },
                    { id: "rotation:90", frame: 90, value: -180, outgoing: { type: "linear" } },
                  ],
                }),
              ],
            },
            {
              id: "clip:second",
              assetId: "asset:video",
              startFrame: 120,
              durationFrames: 120,
              sourceInFrame: 132,
              muted: true,
              effects: [],
              parameterTracks: [],
            },
          ],
        },
        {
          id: "track:v2",
          kind: "video",
          lane: { authoredTrack: 19, displayTrack: 3 },
          clips: [],
        },
        {
          id: "track:a1",
          kind: "audio",
          lane: { authoredTrack: 4, displayTrack: 5 },
          clips: [
            {
              id: "clip:audio",
              assetId: "asset:audio",
              startFrame: 0,
              durationFrames: 120,
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

const findClip = (document: NativeProjectDocument, id: string) =>
  document.sequence.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id);

const expectMove = (document: NativeProjectDocument, command: NativeProjectClipCommand) => {
  const result = applyNativeProjectClipCommand(document, command);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.message);
  return result;
};

describe("native project clip move commands", () => {
  it("moves one exactly addressed clip to a compatible track while preserving all local media state", () => {
    const original = documentFixture();
    const before = JSON.stringify(findClip(original, "clip:first"));
    const result = expectMove(original, {
      type: "move",
      address: firstAddress,
      destination: { trackId: "track:v2", startFrame: 240 },
    });
    const moved = findClip(result.document, "clip:first")!;

    expect(result.document.sequence.tracks.find((track) => track.id === "track:v1")?.clips).toHaveLength(1);
    expect(result.document.sequence.tracks.find((track) => track.id === "track:v2")?.clips).toContain(moved);
    expect(result.document.sequence.tracks.find((track) => track.id === "track:v2")?.lane).toEqual({
      authoredTrack: 19,
      displayTrack: 3,
    });
    expect({ ...moved, startFrame: 0 }).toEqual({ ...JSON.parse(before), startFrame: 0 });
    expect(moved.startFrame).toBe(240);
    expect(result.document.revision).toBe(original.revision);

    const undo = applyNativeProjectClipCommand(result.document, result.inverse);
    expect(undo.ok).toBe(true);
    if (!undo.ok) throw new Error(undo.failure.message);
    expect(serializeNativeProjectDocument(undo.document)).toBe(serializeNativeProjectDocument(original));
  });

  it("applies a multi-clip move atomically in deterministic timeline order", () => {
    const original = documentFixture();
    findClip(original, "clip:first")!.binding = {
      sourceFile: "index.html",
      domId: "clip-first",
      hfId: "hf-clip-first",
      selector: "#clip-first",
      selectorIndex: 0,
    };
    const result = expectMove(original, {
      type: "move-many",
      moves: [
        {
          address: { ...firstAddress, clipId: "clip:second" },
          destination: { trackId: "track:v2", startFrame: 120 },
        },
        { address: firstAddress, destination: { trackId: "track:v2", startFrame: 240 } },
      ],
    });

    expect(
      result.document.sequence.tracks.find((track) => track.id === "track:v2")?.clips.map(
        (clip) => `${clip.id}@${clip.startFrame}`,
      ),
    ).toEqual(["clip:second@120", "clip:first@240"]);
    expect(result.document.sequence.tracks.find((track) => track.id === "track:v1")?.clips).toEqual([]);
    expect(findClip(result.document, "clip:first")?.binding).toEqual(
      findClip(original, "clip:first")?.binding,
    );
    expect(findClip(result.document, "clip:first")?.effects).toEqual(
      findClip(original, "clip:first")?.effects,
    );
    expect(findClip(result.document, "clip:first")?.parameterTracks).toEqual(
      findClip(original, "clip:first")?.parameterTracks,
    );
  });

  it.each([
    [
      "missing sequence",
      {
        type: "move",
        address: { ...firstAddress, sequenceId: "sequence:missing" },
        destination: { trackId: "track:v2", startFrame: 1 },
      },
      "missing-sequence",
    ],
    [
      "missing destination track",
      {
        type: "move",
        address: firstAddress,
        destination: { trackId: "track:missing", startFrame: 1 },
      },
      "missing-destination-track",
    ],
    [
      "missing source track",
      {
        type: "move",
        address: { ...firstAddress, trackId: "track:missing" },
        destination: { trackId: "track:v2", startFrame: 1 },
      },
      "missing-source-track",
    ],
    [
      "missing clip",
      {
        type: "move",
        address: { ...firstAddress, clipId: "clip:missing" },
        destination: { trackId: "track:v2", startFrame: 1 },
      },
      "missing-clip",
    ],
    [
      "fractional start frame",
      {
        type: "move",
        address: firstAddress,
        destination: { trackId: "track:v2", startFrame: 1.5 },
      },
      "invalid-start-frame",
    ],
    [
      "negative start frame",
      {
        type: "move",
        address: firstAddress,
        destination: { trackId: "track:v2", startFrame: -1 },
      },
      "invalid-start-frame",
    ],
  ] as const)("rejects %s without exposing a partial document", (_name, command, code) => {
    const original = documentFixture();
    const result = applyNativeProjectClipCommand(original, command);
    expect(result).toMatchObject({ ok: false, document: original, failure: { code } });
    expect(serializeNativeProjectDocument(original)).toBe(serializeNativeProjectDocument(documentFixture()));
  });

  it("rejects duplicate source targets but allows clips to share a destination time", () => {
    const original = documentFixture();
    const duplicate = applyNativeProjectClipCommand(original, {
      type: "move-many",
      moves: [
        { address: firstAddress, destination: { trackId: "track:v2", startFrame: 30 } },
        { address: firstAddress, destination: { trackId: "track:v2", startFrame: 60 } },
      ],
    });
    expect(duplicate).toMatchObject({ ok: false, document: original, failure: { code: "duplicate-target" } });

    const collision = applyNativeProjectClipCommand(original, {
      type: "move-many",
      moves: [
        { address: firstAddress, destination: { trackId: "track:v2", startFrame: 30 } },
        {
          address: { ...firstAddress, clipId: "clip:second" },
          destination: { trackId: "track:v2", startFrame: 30 },
        },
      ],
    });
    expect(collision.ok).toBe(true);
    if (collision.ok) expect(collision.document.sequence.tracks.find(track => track.id === "track:v2")!.clips.filter(clip => clip.startFrame === 30)).toHaveLength(2);
    expect(serializeNativeProjectDocument(original)).toBe(serializeNativeProjectDocument(documentFixture()));
  });
});

describe("native project clip trim, split, and delete commands", () => {
  it("trims in on an integer frame, advancing source media and rebasing native keyframes without touching effects or static parameters", () => {
    const original = documentFixture();
    const before = findClip(original, "clip:first")!;
    const result = expectMove(original, {
      type: "trim-in",
      address: firstAddress,
      startFrame: 30,
    });
    const trimmed = findClip(result.document, "clip:first")!;
    const rotation = trimmed.parameterTracks[0]!;

    expect(trimmed).toMatchObject({ startFrame: 30, sourceInFrame: 42, durationFrames: 90 });
    expect(trimmed.effects).toEqual(before.effects);
    expect(trimmed.staticParameters).toEqual(before.staticParameters);
    expect(rotation.keyframes.map((keyframe) => [keyframe.frame, keyframe.value])).toEqual([
      [-30, 0],
      [60, -180],
    ]);
  });

  it("trims out at an integer exclusive end, retaining hidden authored keyframes for later extension", () => {
    const result = expectMove(documentFixture(), {
      type: "trim-out",
      address: firstAddress,
      endFrameExclusive: 60,
    });
    const trimmed = findClip(result.document, "clip:first")!;

    expect(trimmed).toMatchObject({ startFrame: 0, sourceInFrame: 12, durationFrames: 60 });
    expect(trimmed.parameterTracks[0]?.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 90]);
  });

  it("splits deterministically, preserving the left clip and creating a right clip with rebased local keyframes", () => {
    const result = expectMove(documentFixture(), {
      type: "split",
      address: firstAddress,
      splitFrame: 60,
    });
    const left = findClip(result.document, "clip:first")!;
    const right = findClip(result.document, nativeSplitClipId("clip:first", 60))!;

    expect(left).toMatchObject({ startFrame: 0, sourceInFrame: 12, durationFrames: 60 });
    expect(right).toMatchObject({ startFrame: 60, sourceInFrame: 72, durationFrames: 60 });
    expect(right.effects).toEqual(left.effects);
    expect(right.staticParameters).toEqual(left.staticParameters);
    expect(left.parameterTracks[0]?.keyframes.map((keyframe) => [keyframe.frame, keyframe.value])).toEqual([[0, 0], [90, -180]]);
    expect(right.parameterTracks[0]?.keyframes.map((keyframe) => [keyframe.frame, keyframe.value])).toEqual([
      [-60, 0],
      [30, -180],
    ]);
    expect(right.parameterTracks[0]?.id).not.toBe(left.parameterTracks[0]?.id);
  });

  it("advances source media by the exact rational playback rate when trimming and splitting", () => {
    const fast = documentFixture();
    findClip(fast, "clip:first")!.playbackRate = { numerator: 2, denominator: 1 };
    const trimmed = expectMove(fast, {
      type: "trim-in",
      address: firstAddress,
      startFrame: 30,
    });
    expect(findClip(trimmed.document, "clip:first")).toMatchObject({
      sourceInFrame: 72,
      playbackRate: { numerator: 2, denominator: 1 },
    });

    const slow = documentFixture();
    findClip(slow, "clip:first")!.playbackRate = { numerator: 1, denominator: 2 };
    const split = expectMove(slow, {
      type: "split",
      address: firstAddress,
      splitFrame: 60,
    });
    expect(findClip(split.document, nativeSplitClipId("clip:first", 60))).toMatchObject({
      sourceInFrame: 42,
      playbackRate: { numerator: 1, denominator: 2 },
    });
  });

  it("rejects trim and split boundaries that cannot map to an integer source frame", () => {
    const original = documentFixture();
    findClip(original, "clip:first")!.playbackRate = { numerator: 1, denominator: 2 };

    const trim = applyNativeProjectClipCommand(original, {
      type: "trim-in",
      address: firstAddress,
      startFrame: 1,
    });
    expect(trim).toMatchObject({
      ok: false,
      document: original,
      failure: { code: "non-integral-source-boundary" },
    });

    const split = applyNativeProjectClipCommand(original, {
      type: "split",
      address: firstAddress,
      splitFrame: 1,
    });
    expect(split).toMatchObject({
      ok: false,
      document: original,
      failure: { code: "non-integral-source-boundary" },
    });
  });

  it("requires a bound split to provide a unique explicit right-side binding", () => {
    const original = documentFixture();
    findClip(original, "clip:first")!.binding = {
      sourceFile: "index.html",
      domId: "clip-first-left",
    };

    const result = applyNativeProjectClipCommand(original, {
      type: "split",
      address: firstAddress,
      splitFrame: 60,
    });

    expect(result).toMatchObject({
      ok: false,
      document: original,
      failure: { code: "missing-split-binding" },
    });
  });

  it("preserves the left binding and assigns only the explicit unique binding to the split right clip", () => {
    const original = documentFixture();
    const leftBinding = { sourceFile: "index.html", domId: "clip-first-left" };
    findClip(original, "clip:first")!.binding = leftBinding;

    const result = expectMove(original, {
      type: "split",
      address: firstAddress,
      splitFrame: 60,
      rightBinding: { sourceFile: "index.html", domId: "clip-first-right" },
    });

    expect(findClip(result.document, "clip:first")?.binding).toEqual(leftBinding);
    expect(findClip(result.document, nativeSplitClipId("clip:first", 60))?.binding).toEqual({
      sourceFile: "index.html",
      domId: "clip-first-right",
    });
  });

  it.each([
    ["duplicates the left binding", { sourceFile: "index.html", domId: "clip-first-left" }],
    ["duplicates another clip binding", { sourceFile: "index.html", domId: "clip-second" }],
    ["is malformed", { sourceFile: "index.html" }],
  ])("rejects a right-side split binding that %s atomically", (_name, rightBinding) => {
    const original = documentFixture();
    findClip(original, "clip:first")!.binding = {
      sourceFile: "index.html",
      domId: "clip-first-left",
    };
    findClip(original, "clip:second")!.binding = {
      sourceFile: "index.html",
      domId: "clip-second",
    };

    const result = applyNativeProjectClipCommand(original, {
      type: "split",
      address: firstAddress,
      splitFrame: 60,
      rightBinding,
    });

    expect(result).toMatchObject({
      ok: false,
      document: original,
      failure: {
        code: _name === "is malformed" ? "invalid-split-binding" : "duplicate-split-binding",
      },
    });
  });

  it("deletes one or several exactly addressed clips atomically", () => {
    const original = documentFixture();
    const result = expectMove(original, {
      type: "delete-many",
      addresses: [firstAddress, { ...firstAddress, clipId: "clip:second" }],
    });
    expect(result.document.sequence.tracks.find((track) => track.id === "track:v1")?.clips).toEqual([]);
    expect(findClip(result.document, "clip:audio")).toBeDefined();
  });

  it.each([
    ["trim-in before clip", { type: "trim-in", address: firstAddress, startFrame: -1 }, "invalid-trim"],
    ["trim-out at start", { type: "trim-out", address: firstAddress, endFrameExclusive: 0 }, "invalid-trim"],
    ["split at end", { type: "split", address: firstAddress, splitFrame: 120 }, "invalid-split"],
    [
      "duplicate delete target",
      { type: "delete-many", addresses: [firstAddress, firstAddress] },
      "duplicate-target",
    ],
  ] as const)("rejects %s atomically", (_name, command, code) => {
    const original = documentFixture();
    const result = applyNativeProjectClipCommand(original, command);
    expect(result).toMatchObject({ ok: false, document: original, failure: { code } });
  });

  it("rejects a split whose deterministic child ID would collide, without changing the source", () => {
    const original = documentFixture();
    const collisionId = nativeSplitClipId("clip:first", 60);
    const collision = parseNativeProjectDocument({
      ...original,
      sequence: {
        ...original.sequence,
        tracks: original.sequence.tracks.map((track) =>
          track.id !== "track:v2"
            ? track
            : {
                ...track,
                clips: [
                  ...track.clips,
                  {
                    id: collisionId,
                    assetId: "asset:video",
                    startFrame: 500,
                    durationFrames: 10,
                    sourceInFrame: 0,
                    muted: false,
                    effects: [],
                    parameterTracks: [],
                  },
                ],
              },
        ),
      },
    });

    const result = applyNativeProjectClipCommand(collision, {
      type: "split",
      address: firstAddress,
      splitFrame: 60,
    });
    expect(result).toMatchObject({ ok: false, document: collision, failure: { code: "generated-id-collision" } });
  });
});


describe("timeline resize extension", () => {
  it("extends trim-out into available source media without retiming keys", () => {
    const original = documentFixture();
    const result = expectMove(original, { type: "trim-out", address: firstAddress, endFrameExclusive: 180 });
    expect(findClip(result.document, "clip:first")!.durationFrames).toBe(180);
    expect(findClip(result.document, "clip:first")!.parameterTracks).toEqual(findClip(original, "clip:first")!.parameterTracks);
  });

  it("extends a still image beyond its initial duration", () => {
    const original = documentFixture();
    original.assets[0]!.kind = "image";
    const result = expectMove(original, { type: "trim-out", address: firstAddress, endFrameExclusive: 1200 });
    expect(findClip(result.document, "clip:first")!.durationFrames).toBe(1200);
  });

  it("extends trim-in using available source handles and shifts keys by the same frames", () => {
    const original = documentFixture();
    findClip(original, "clip:first")!.startFrame = 30;
    const result = expectMove(original, { type: "trim-in", address: firstAddress, startFrame: 24 });
    const clip = findClip(result.document, "clip:first")!;
    expect(clip).toMatchObject({ startFrame: 24, sourceInFrame: 6, durationFrames: 126 });
    expect(clip.parameterTracks[0]!.keyframes.find((key) => key.id === "rotation:90")!.frame).toBe(96);
  });

  it("rejects extending timed media past its available source with an actionable reason", () => {
    const result = applyNativeProjectClipCommand(documentFixture(), { type: "trim-out", address: firstAddress, endFrameExclusive: 1000 });
    expect(result).toMatchObject({ ok: false, failure: { code: "invalid-trim", message: expect.stringContaining("source") } });
  });

  it("preserves the visible linear motion when trimming before the next key", () => {
    const original = documentFixture();
    const result = expectMove(original, { type: "trim-out", address: firstAddress, endFrameExclusive: 60 });
    const before = findClip(original, "clip:first")!.parameterTracks[0]!;
    const after = findClip(result.document, "clip:first")!.parameterTracks[0]!;
    for (let frame = 0; frame < 60; frame++) {
      expect(evaluateNativeParameterTrack(after, frame)).toBeCloseTo(evaluateNativeParameterTrack(before, frame) as number, 6);
    }
  });
});


it.each(["trim-in", "trim-out"] as const)("preserves every visible eased frame after %s", (type) => {
  const original = documentFixture();
  const track = findClip(original, "clip:first")!.parameterTracks[0]!;
  (track.keyframes[0] as any).outgoing = { type: "cubic-bezier", controlPoints: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } };
  const result = expectMove(original, type === "trim-in"
    ? { type, address: firstAddress, startFrame: 30 }
    : { type, address: firstAddress, endFrameExclusive: 60 });
  const clip = findClip(result.document, "clip:first")!;
  for (let frame = 0; frame < clip.durationFrames; frame++) {
    expect(evaluateNativeParameterTrack(clip.parameterTracks[0]!, frame)).toBeCloseTo(
      evaluateNativeParameterTrack(track, frame + (type === "trim-in" ? 30 : 0)) as number, 5,
    );
  }
});
