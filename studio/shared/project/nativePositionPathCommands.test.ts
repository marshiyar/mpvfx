import { describe, expect, it } from "vitest";

import { evaluateNativeParameterTrack } from "./nativeKeyframeEvaluator";
import { createNativeParameterTrack, type NativeParameterTrack } from "./nativeKeyframeTypes";
import {
  applyNativeProjectKeyframeCommand,
  type NativeProjectKeyframeCommand,
} from "./nativeProjectKeyframeCommands";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";

const frameRate = { numerator: 30, denominator: 1 } as const;
const clipAddress = { sequenceId: "sequence:main", trackId: "track:video", clipId: "clip:first" } as const;
const at = (parameterId: string) => ({ ...clipAddress, parameterId });
const ease = { type: "cubic-bezier", controlPoints: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } } as const;

const scalar = (parameterId: string, values: readonly [number, number, number], easing = true) =>
  createNativeParameterTrack({
    id: `parameter:${parameterId}`,
    parameterId,
    valueType: "number",
    frameRate,
    keyframes: [
      { id: `${parameterId}:0`, frame: 0, value: values[0], outgoing: easing ? ease : { type: "linear" } },
      { id: `${parameterId}:40`, frame: 40, value: values[1], outgoing: { type: "linear" } },
      { id: `${parameterId}:90`, frame: 90, value: values[2], outgoing: { type: "linear" } },
    ],
  });

const makeDocument = (tracks: NativeParameterTrack[]): NativeProjectDocument =>
  parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:demo",
    revision: 1,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#101010" },
    assets: [{ id: "asset:video", kind: "video", name: "video.mov", durationFrames: 360 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "track:video",
        kind: "video",
        clips: [{
          id: "clip:first", assetId: "asset:video", startFrame: 0, durationFrames: 120, sourceInFrame: 0,
          muted: false, effects: [], parameterTracks: tracks,
        }],
      }],
    },
  });

const clipTracks = (document: NativeProjectDocument) => document.sequence.tracks[0]!.clips[0]!.parameterTracks;
const position = (document: NativeProjectDocument) =>
  clipTracks(document).find((track) => track.parameterId === "transform.position") as NativeParameterTrack<"vec2">;

const apply = (document: NativeProjectDocument, command: NativeProjectKeyframeCommand) => {
  const result = applyNativeProjectKeyframeCommand(document, command);
  if (!result.ok) throw new Error(`${result.failure.code}: ${result.failure.message}`);
  return result;
};

describe("native motion paths on position", () => {
  const original = () => makeDocument([scalar("transform.position.x", [0, 400, 700]), scalar("transform.position.y", [0, 0, 250])]);

  it("merges aligned x/y tracks into one 2D position without changing any frame", () => {
    const before = original();
    const after = apply(before, { type: "set-auto-rotate", address: at("transform.position"), autoRotate: true }).document;
    expect(clipTracks(after).map((track) => track.parameterId)).toEqual(["transform.position"]);
    expect(position(after).autoRotate).toBe(true);
    const [x, y] = clipTracks(before) as NativeParameterTrack<"number">[];
    for (let frame = 0; frame < 120; frame += 1) {
      const merged = evaluateNativeParameterTrack(position(after), frame);
      expect(merged.x).toBeCloseTo(evaluateNativeParameterTrack(x!, frame), 9);
      expect(merged.y).toBeCloseTo(evaluateNativeParameterTrack(y!, frame), 9);
    }
  });

  it("curves a segment: keyframes are still reached at their frames, the path bends between them", () => {
    const curved = apply(original(), {
      type: "set-motion-path", address: at("transform.position"), frame: 0, path: { type: "curve", curviness: 1 },
    }).document;
    const track = position(curved);
    expect(track.keyframes[0]!.outgoingPath).toEqual({ type: "curve", curviness: 1 });
    expect(evaluateNativeParameterTrack(track, 40)).toEqual({ x: 400, y: 0 });
    // Straight from (0,0) to (400,0) would keep y = 0; the curve leaves the chord.
    expect(Math.abs(evaluateNativeParameterTrack(track, 20).y)).toBeGreaterThan(1);
    const straight = apply(curved, { type: "set-motion-path", address: at("transform.position"), frame: 0, path: null }).document;
    expect(position(straight).keyframes[0]!.outgoingPath).toBeUndefined();
  });

  it("refuses x/y keyframes that do not line up instead of approximating them", () => {
    const misaligned = makeDocument([
      scalar("transform.position.x", [0, 400, 700]),
      scalar("transform.position.y", [0, 0, 250], false),
    ]);
    const result = applyNativeProjectKeyframeCommand(misaligned, {
      type: "set-motion-path", address: at("transform.position"), frame: 0, path: { type: "curve", curviness: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("position-components-misaligned");
    expect(result.document).toBe(misaligned);
  });

  it("rejects a path on the last keyframe, which has no following segment", () => {
    const result = applyNativeProjectKeyframeCommand(original(), {
      type: "set-motion-path", address: at("transform.position"), frame: 90, path: { type: "curve", curviness: 1 },
    });
    expect(result.ok).toBe(false);
  });

  describe("x/y edits on a 2D position", () => {
    const curved = () => apply(original(), {
      type: "set-motion-path", address: at("transform.position"), frame: 0, path: { type: "curve", curviness: 1 },
    }).document;

    it("changes one component of an existing key and keeps its easing and path", () => {
      const edited = apply(curved(), {
        type: "upsert", address: at("transform.position.x"), valueType: "number", frame: 0, value: 50, baselineValue: 0,
      }).document;
      const key = position(edited).keyframes[0]!;
      expect(key.value).toEqual({ x: 50, y: 0 });
      expect(key.outgoing).toEqual(ease);
      expect(key.outgoingPath).toEqual({ type: "curve", curviness: 1 });
      expect(clipTracks(edited).map((track) => track.parameterId)).toEqual(["transform.position"]);
    });

    it("adds a key between keys with the other component taken from the curve", () => {
      const document = curved();
      const onCurve = evaluateNativeParameterTrack(position(document), 20);
      const edited = apply(document, {
        type: "upsert", address: at("transform.position.x"), valueType: "number", frame: 20, value: 123, baselineValue: 0,
      }).document;
      expect(position(edited).keyframes.find((key) => key.frame === 20)!.value).toEqual({ x: 123, y: onCurve.y });
    });

    it("applies paired x/y structural edits once", () => {
      const moved = apply(curved(), {
        type: "batch",
        commands: [
          { type: "move", address: at("transform.position.x"), fromFrame: 40, toFrame: 50 },
          { type: "move", address: at("transform.position.y"), fromFrame: 40, toFrame: 50 },
        ],
      }).document;
      expect(position(moved).keyframes.map((key) => key.frame)).toEqual([0, 50, 90]);
      const deleted = apply(moved, {
        type: "batch",
        commands: [
          { type: "delete", address: at("transform.position.x"), frame: 50 },
          { type: "delete", address: at("transform.position.y"), frame: 50 },
        ],
      }).document;
      expect(position(deleted).keyframes.map((key) => key.frame)).toEqual([0, 90]);
    });

    it("undoes a path edit exactly through its inverse", () => {
      const document = curved();
      const result = apply(document, { type: "set-auto-rotate", address: at("transform.position"), autoRotate: true });
      const restored = apply(result.document, result.inverse).document;
      expect(position(restored).autoRotate).toBeUndefined();
      expect(position(restored).keyframes).toEqual(position(document).keyframes);
    });
  });
});

describe("displaying a 2D position", () => {
  const curvedDocument = () => apply(
    makeDocument([scalar("transform.position.x", [0, 400, 700]), scalar("transform.position.y", [0, 0, 250])]),
    { type: "set-motion-path", address: at("transform.position"), frame: 0, path: { type: "curve", curviness: 1 } },
  ).document;
  const selected = { dataset: { studioClipId: "clip:first" }, attributes: { "data-studio-clip-id": "clip:first" } };

  it("shows x and y rows with values taken from the curve", async () => {
    const { projectNativeKeyframeUi } = await import("./nativeKeyframeUiProjection");
    const document = curvedDocument();
    const result = projectNativeKeyframeUi(document, { selectedElement: selected, playheadSeconds: 20 / 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const onCurve = evaluateNativeParameterTrack(position(document), 20);
    expect(result.currentValues.x).toBeCloseTo(onCurve.x, 9);
    expect(result.currentValues.y).toBeCloseTo(onCurve.y, 9);
    expect(result.keyframeRows.filter((row) => "x" in row.properties).map((row) => row.parameterId))
      .toEqual(["transform.position.x", "transform.position.x", "transform.position.x"]);
    expect(result.keyframeRows.filter((row) => "y" in row.properties).map((row) => row.properties.y)).toEqual([0, 0, 250]);
  });

  it("shows separate x and y timeline lanes that share the keyframe identities", async () => {
    const { projectNativeTimelineKeyframes } = await import("./nativeTimelineKeyframeProjection");
    const result = projectNativeTimelineKeyframes(curvedDocument(), selected);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lanes = JSON.stringify(result);
    expect(lanes).toContain('"parameterId":"transform.position.x"');
    expect(lanes).toContain('"parameterId":"transform.position.y"');
    const laneIds = [...lanes.matchAll(/"laneId":"([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(laneIds).size).toBe(laneIds.length);
  });
});

describe("property commands on a 2D position (the path the editor UI uses)", () => {
  const bezierDocument = () => apply(
    makeDocument([scalar("transform.position.x", [0, 400, 700]), scalar("transform.position.y", [0, 0, 250])]),
    {
      type: "set-motion-path", address: at("transform.position"), frame: 0,
      path: { type: "bezier", cp1: { x: 0, y: 300 }, cp2: { x: 400, y: 300 } },
    },
  ).document;
  const property = async () => (await import("./nativeProjectPropertyCommands")).applyNativeProjectPropertyCommand;

  it("applies an x/y pair of moves once", async () => {
    const applyProperty = await property();
    const result = applyProperty(bezierDocument(), {
      type: "batch",
      commands: [
        { type: "move", address: at("transform.position.x"), fromFrame: 40, toFrame: 55 },
        { type: "move", address: at("transform.position.y"), fromFrame: 40, toFrame: 55 },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(position(result.document).keyframes.map((key) => key.frame)).toEqual([0, 55, 90]);
  });

  it("collapses the whole 2D position to its value at the playhead", async () => {
    const applyProperty = await property();
    const document = bezierDocument();
    const expected = evaluateNativeParameterTrack(position(document), 20);
    const result = applyProperty(document, { type: "collapse-track", address: at("transform.position.x"), frame: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clip = result.document.sequence.tracks[0]!.clips[0]!;
    expect(clip.parameterTracks).toEqual([]);
    expect(clip.staticParameters?.["transform.position"]).toEqual(expected);
    expect(clip.staticParameters?.["transform.position.x"]).toBeUndefined();
  });

  it.each([25, -25])("offsets both position components by %s without dropping either edit", async (delta) => {
    const applyProperty = await property();
    const document = bezierDocument();
    const result = applyProperty(document, {
      type: "batch",
      commands: [
        { type: "offset-track", address: at("transform.position.x"), delta },
        { type: "offset-track", address: at("transform.position.y"), delta },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const translated = position(result.document);
    expect(translated.keyframes[0]!.outgoingPath).toEqual({
      type: "bezier", cp1: { x: delta, y: 300 + delta }, cp2: { x: 400 + delta, y: 300 + delta },
    });
    for (let frame = 0; frame <= 90; frame += 1) {
      const before = evaluateNativeParameterTrack(position(document), frame);
      const after = evaluateNativeParameterTrack(translated, frame);
      expect(after.x).toBeCloseTo(before.x + delta, 6);
      expect(after.y).toBeCloseTo(before.y + delta, 6);
    }
  });

  it("offsets one component of the path, moving Bezier handles with it", async () => {
    const applyProperty = await property();
    const document = bezierDocument();
    const result = applyProperty(document, { type: "offset-track", address: at("transform.position.x"), delta: 25 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (let frame = 0; frame <= 90; frame += 5) {
      const before = evaluateNativeParameterTrack(position(document), frame);
      const after = evaluateNativeParameterTrack(position(result.document), frame);
      expect(after.x).toBeCloseTo(before.x + 25, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  it("refuses a static x that would override the animated 2D position", async () => {
    const applyProperty = await property();
    const document = bezierDocument();
    const result = applyProperty(document, { type: "set-static", address: at("transform.position.x"), value: 3 });
    expect(result.ok).toBe(false);
    expect(result.document).toBe(document);
  });
});
