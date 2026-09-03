import { describe, expect, it } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { planNativeTimelineMultiRangeEdit } from "./nativeTimelineMultiRangeEditPlan";

const frameRate = { numerator: 30_000, denominator: 1_001 } as const;
const secondsAtFrame = (frame: number) => (frame * frameRate.denominator) / frameRate.numerator;

function project(options?: { unboundSecond?: boolean }): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:multi-range",
    revision: 12,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#101010" },
    assets: [
      { id: "asset:a", kind: "video", name: "a.mov", durationFrames: 900 },
      { id: "asset:b", kind: "video", name: "b.mov", durationFrames: 900 },
    ],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "track:v1",
        kind: "video",
        lane: { authoredTrack: 2, displayTrack: 0 },
        clips: [{
          id: "clip:a",
          assetId: "asset:a",
          binding: { sourceFile: "z.html", domId: "clip-a", hfId: "hf-a" },
          startFrame: 30,
          durationFrames: 120,
          sourceInFrame: 10,
          playbackRate: { numerator: 2, denominator: 1 },
          muted: true,
          staticParameters: { opacity: 0.75 },
          effects: [{ id: "fx:a", effectId: "blur", enabled: true }],
          parameterTracks: [{
            schemaVersion: 1,
            id: "param:a",
            parameterId: "transform.rotation",
            valueType: "number",
            frameRate,
            keyframes: [
              { id: "key:a0", frame: 0, value: 0, outgoing: { type: "linear" } },
              { id: "key:a1", frame: 60, value: 180, outgoing: { type: "hold" } },
            ],
          }],
        }, {
          id: "clip:b",
          assetId: "asset:b",
          ...(options?.unboundSecond
            ? {}
            : { binding: { sourceFile: "a.html", domId: "clip-b", hfId: "hf-b" } }),
          startFrame: 180,
          durationFrames: 90,
          sourceInFrame: 20,
          playbackRate: { numerator: 2, denominator: 1 },
          muted: false,
          staticParameters: { scale: 1.25 },
          effects: [{ id: "fx:b", effectId: "grade", enabled: false }],
          parameterTracks: [],
        }],
      }],
    },
  });
}

const changes = [{
  element: { id: "clip-a", hfId: "hf-a", sourceFile: "z.html" },
  requestedStartSeconds: secondsAtFrame(45) + 1e-12,
  requestedDurationSeconds: secondsAtFrame(105) + 1e-12,
}, {
  element: { id: "clip-b", hfId: "hf-b", sourceFile: "a.html" },
  requestedStartSeconds: secondsAtFrame(180),
  requestedDurationSeconds: secondsAtFrame(60),
}] as const;

describe("native timeline multi-clip range planner", () => {
  it("plans exact 30000/1001 trim-in and trim-out edits with 2x source math", () => {
    const result = planNativeTimelineMultiRangeEdit({ document: project(), changes });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceFiles).toEqual(["a.html", "z.html"]);
    expect(result.edits.map((edit) => ({
      clipId: edit.address.clipId,
      kind: edit.kind,
      timing: edit.compatibility,
    }))).toEqual([{
      clipId: "clip:a",
      kind: "trim-in",
      timing: {
        start: String(secondsAtFrame(45)),
        duration: String(secondsAtFrame(105)),
        sourceOffset: String(secondsAtFrame(40)),
      },
    }, {
      clipId: "clip:b",
      kind: "trim-out",
      timing: {
        start: String(secondsAtFrame(180)),
        duration: String(secondsAtFrame(60)),
        sourceOffset: String(secondsAtFrame(20)),
      },
    }]);

    const [clipA, clipB] = result.document.sequence.tracks[0]!.clips;
    expect(clipA).toMatchObject({
      startFrame: 45,
      durationFrames: 105,
      sourceInFrame: 40,
      playbackRate: { numerator: 2, denominator: 1 },
      muted: true,
      staticParameters: { opacity: 0.75 },
      effects: [{ id: "fx:a", effectId: "blur", enabled: true }],
      binding: { sourceFile: "z.html", domId: "clip-a", hfId: "hf-a" },
    });
    expect(clipA!.parameterTracks[0]!.keyframes).toMatchObject([
      { frame: 0, value: 45 },
      { id: "key:a1", frame: 45, value: 180 },
    ]);
    expect(clipB).toMatchObject({
      startFrame: 180,
      durationFrames: 60,
      sourceInFrame: 20,
      playbackRate: { numerator: 2, denominator: 1 },
      muted: false,
      staticParameters: { scale: 1.25 },
      effects: [{ id: "fx:b", effectId: "grade", enabled: false }],
      binding: { sourceFile: "a.html", domId: "clip-b", hfId: "hf-b" },
    });
  });

  it("rejects duplicate native targets even when aliases differ, without mutating the input", () => {
    const original = project();
    const bytes = serializeNativeProjectDocument(original);
    const result = planNativeTimelineMultiRangeEdit({
      document: original,
      changes: [changes[0], {
        element: { dataset: { studioClipId: "clip:a" }, sourceFile: "z.html" },
        requestedStartSeconds: secondsAtFrame(30),
        requestedDurationSeconds: secondsAtFrame(60),
      }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ code: "duplicate-clip", changeIndex: 1 });
    expect(serializeNativeProjectDocument(original)).toBe(bytes);
  });

  it("rejects the whole batch when a later edit moves both boundaries", () => {
    const original = project();
    const bytes = serializeNativeProjectDocument(original);
    const result = planNativeTimelineMultiRangeEdit({
      document: original,
      changes: [changes[0], {
        ...changes[1],
        requestedStartSeconds: secondsAtFrame(190),
        requestedDurationSeconds: secondsAtFrame(50),
      }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ code: "unsupported-range-change", changeIndex: 1 });
    expect(serializeNativeProjectDocument(original)).toBe(bytes);
  });

  it("rejects an unbound member instead of partially applying the valid edit", () => {
    const original = project({ unboundSecond: true });
    const bytes = serializeNativeProjectDocument(original);
    const result = planNativeTimelineMultiRangeEdit({
      document: original,
      changes: [changes[0], {
        ...changes[1],
        element: { dataset: { studioClipId: "clip:b" }, sourceFile: undefined },
      }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ code: "unbound-clip", changeIndex: 1 });
    expect(serializeNativeProjectDocument(original)).toBe(bytes);
  });

  it("rejects ambiguous and invalid members before producing a document", () => {
    const base = project();
    const ambiguousDocument = parseNativeProjectDocument({
      ...base,
      sequence: {
        ...base.sequence,
        tracks: base.sequence.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => clip.id === "clip:b"
            ? { ...clip, binding: { ...clip.binding!, sourceFile: "z.html" } }
            : clip),
        })),
      },
    });
    const ambiguous = planNativeTimelineMultiRangeEdit({
      document: ambiguousDocument,
      changes: [{
        element: { id: "clip-a", hfId: "hf-b", sourceFile: "z.html" },
        requestedStartSeconds: secondsAtFrame(45),
        requestedDurationSeconds: secondsAtFrame(105),
      }],
    });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.failure).toMatchObject({ code: "ambiguous-clip", changeIndex: 0 });
    }

    const invalid = planNativeTimelineMultiRangeEdit({
      document: project(),
      changes: [{ ...changes[0], requestedDurationSeconds: Number.NaN }],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.failure).toMatchObject({ code: "invalid-range", changeIndex: 0 });
    }
  });
});
