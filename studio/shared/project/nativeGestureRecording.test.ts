import { describe, expect, it } from "vitest";
import { fitEasesFromVelocity } from "../../src/features/canvas/velocityEaseFitter";
import { applyNativeGestureRecording } from "./nativeGestureRecording";
import { parseNativeProjectDocument } from "./nativeProjectDocument";
import { createNativeParameterTrack } from "./nativeKeyframeTypes";
import { evaluateNativeParameterTrack } from "./nativeKeyframeEvaluator";

const rate = { numerator: 30, denominator: 1 };
const project = () => parseNativeProjectDocument({ schemaVersion: 1, id: "project", revision: 0,
  frameRate: rate, canvas: { width: 100, height: 100, background: "#000000" },
  assets: [{ id: "asset", kind: "image", name: "card", durationFrames: 300 }],
  sequence: { id: "sequence", name: "Main", tracks: [{ id: "track", kind: "video", clips: [{
    id: "clip", assetId: "asset", startFrame: 30, durationFrames: 120, sourceInFrame: 0,
    muted: false, effects: [], parameterTracks: [],
  }] }] },
});
const request = { selectedElement: { attributes: { "data-studio-clip-id": "clip" } },
  playheadSeconds: 2, selectionBounds: { width: 100, height: 100 } };
const keys = [
  { percentage: 0, properties: { x: 0, y: 10, opacity: 1 } },
  { percentage: 50, properties: { x: 50, y: 20, opacity: 0.5 } },
  { percentage: 100, properties: { x: 100, y: 30, opacity: 0 } },
];
const tracks = (doc: ReturnType<typeof project>) => doc.sequence.tracks[0]!.clips[0]!.parameterTracks;

describe("native gesture recording", () => {
  it("authors all properties at clip-local output frames in one immutable result", () => {
    const before = project();
    const after = applyNativeGestureRecording(before, request, 1, keys);
    expect(tracks(before)).toHaveLength(0);
    expect(tracks(after)).toHaveLength(3);
    const x = tracks(after).find(t => t.parameterId === "transform.position.x")!;
    expect(x.keyframes.map(k => k.frame)).toEqual([30, 45, 60]);
    expect(evaluateNativeParameterTrack(x, 39)).toBeCloseTo(30);
    expect(parseNativeProjectDocument(JSON.parse(JSON.stringify(after)))).toEqual(after);
  });

  it("applies the real velocity fitter's incoming ease to the preceding native segment", () => {
    const fitted = fitEasesFromVelocity([
      { percentage: 0, properties: { x: 0 } },
      { percentage: 50, properties: { x: 100 } },
      { percentage: 100, properties: { x: 200 } },
    ], Array.from({ length: 21 }, (_, i) => {
      const time = i / 10;
      return { time, properties: { x: time <= 1 ? 100 * time ** 3 : 100 * time } };
    }), 2);
    expect(fitted[1]!.ease).toBe("custom(M0,0 C0.333,0 0.667,0.667 1,1)");
    expect(fitted[2]!.ease).toBeUndefined();
    const after = applyNativeGestureRecording(project(), request, 2, fitted);
    const x = tracks(after)[0]!;
    // First segment accelerates; the following constant-speed segment stays linear.
    expect(evaluateNativeParameterTrack(x, 45)).toBeCloseTo(37.5125, 3);
    expect(evaluateNativeParameterTrack(x, 75)).toBeCloseTo(150);
    expect(x.keyframes[1]!.outgoing).toEqual({ type: "linear" });
  });

  it("replaces keys within the recording and preserves keys outside and unrelated parameters", () => {
    const before = project();
    const track = (parameterId: string) => createNativeParameterTrack({ id: parameterId, parameterId,
      valueType: "number", frameRate: rate, keyframes: [0, 40, 90].map(frame => ({
        id: String(frame), frame, value: frame, outgoing: { type: "linear" as const },
      })) });
    tracks(before).push(track("transform.position.x"), track("transform.rotation"));
    const after = applyNativeGestureRecording(before, request, 1, keys);
    expect(tracks(after).find(t => t.parameterId === "transform.position.x")!.keyframes.map(k => k.frame))
      .toEqual([0, 30, 45, 60, 90]);
    expect(tracks(after).find(t => t.parameterId === "transform.rotation"))
      .toEqual(tracks(before)[1]);
  });

  it("uses the last sample when multiple samples land on one frame", () => {
    const after = applyNativeGestureRecording(project(), request, 1, [
      { percentage: 0, properties: { x: 0 }, ease: "custom(M0,0 C0.333,0 0.667,1 1,1)" },
      { percentage: 0.1, properties: { x: 20 } },
      { percentage: 100, properties: { x: 100 } },
    ]);
    expect(tracks(after)[0]!.keyframes[0]).toMatchObject({ frame: 30, value: 20, outgoing: { type: "linear" } });
  });

  it("replaces an existing curved position without retaining old spatial handles", () => {
    const before = project();
    tracks(before).push(createNativeParameterTrack({ id: "position", parameterId: "transform.position",
      valueType: "vec2", frameRate: rate, keyframes: [
        { id: "a", frame: 30, value: { x: 0, y: 0 }, outgoing: { type: "linear" },
          outgoingPath: { type: "bezier", cp1: { x: 500, y: 500 }, cp2: { x: -500, y: 500 } } },
        { id: "b", frame: 60, value: { x: 100, y: 100 }, outgoing: { type: "linear" } },
      ],
    }));
    const after = applyNativeGestureRecording(before, request, 1, keys);
    const position = tracks(after).find(t => t.parameterId === "transform.position")!;
    expect(position.keyframes[0]!.outgoingPath).toBeUndefined();
    expect(evaluateNativeParameterTrack(position, 39)).toEqual({ x: 30, y: 16 });
    expect(tracks(before)[0]!.keyframes[0]!.outgoingPath).toBeDefined();
  });

  it("rejects unsupported properties without changing the input", () => {
    const before = project();
    expect(() => applyNativeGestureRecording(before, request, 1, [keys[0]!, { percentage: 100, properties: { color: "red" } }]))
      .toThrow("not supported");
    expect(tracks(before)).toHaveLength(0);
  });
});
