import { describe, expect, it } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { planNativeTimelineDelete } from "./nativeTimelineDeletePlan";

const frameRate = { numerator: 30_000, denominator: 1_001 } as const;

function project(): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:delete",
    revision: 12,
    frameRate,
    canvas: { width: 3840, height: 2160, background: "#101010" },
    assets: [
      { id: "asset:a", kind: "video", name: "a.mov", durationFrames: 1_000 },
      { id: "asset:b", kind: "video", name: "b.mov", durationFrames: 1_000 },
      { id: "asset:c", kind: "audio", name: "c.wav", durationFrames: 1_000 },
    ],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "video-track",
        kind: "video",
        lane: { authoredTrack: 7, displayTrack: 0 },
        clips: [{
          id: "clip:a",
          assetId: "asset:a",
          binding: { sourceFile: "z.html", domId: "dom-a", hfId: "hf-a" },
          startFrame: 30,
          durationFrames: 120,
          sourceInFrame: 14,
          playbackRate: { numerator: 2, denominator: 1 },
          muted: true,
          staticParameters: { opacity: 0.75 },
          effects: [{ id: "fx:a", effectId: "grade", enabled: true, parameters: { mix: 0.4 } }],
          parameterTracks: [{
            schemaVersion: 1,
            id: "parameter:a",
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
          binding: { sourceFile: "z.html", selector: ".clip-b", selectorIndex: 1 },
          startFrame: 200,
          durationFrames: 90,
          sourceInFrame: 20,
          playbackRate: { numerator: 1, denominator: 2 },
          muted: false,
          staticParameters: { "transform.position.x": 44 },
          effects: [{ id: "fx:b", effectId: "blur", enabled: false }],
          parameterTracks: [],
        }],
      }, {
        id: "audio-track",
        kind: "audio",
        lane: { authoredTrack: 12, displayTrack: 1 },
        clips: [{
          id: "clip:c",
          assetId: "asset:c",
          binding: { sourceFile: "a.html", domId: "dom-c" },
          startFrame: 10,
          durationFrames: 80,
          sourceInFrame: 4,
          playbackRate: { numerator: 1, denominator: 1 },
          muted: false,
          staticParameters: { "audio.volume": 0.8 },
          effects: [{ id: "fx:c", effectId: "compressor", enabled: true }],
          parameterTracks: [],
        }],
      }],
    },
  });
}

const targetA = { id: "dom-a", hfId: "hf-a", sourceFile: "z.html" } as const;
const targetB = {
  sourceFile: "z.html",
  selector: ".clip-b",
  selectorIndex: 1,
} as const;
const targetC = { id: "dom-c", sourceFile: "a.html" } as const;

describe("native timeline delete planner", () => {
  it("deletes exact bound clips across tracks in one immutable command and preserves unrelated state", () => {
    const original = project();
    const originalBytes = JSON.stringify(original);
    const untouched = structuredClone(original.sequence.tracks[0]!.clips[1]!);

    const result = planNativeTimelineDelete({ document: original, targets: [targetA, targetC] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceFiles).toEqual(["a.html", "z.html"]);
    expect(result.deletions).toEqual([
      expect.objectContaining({
        address: { sequenceId: "sequence:main", trackId: "video-track", clipId: "clip:a" },
        sourceFile: "z.html",
        binding: { sourceFile: "z.html", domId: "dom-a", hfId: "hf-a" },
      }),
      expect.objectContaining({
        address: { sequenceId: "sequence:main", trackId: "audio-track", clipId: "clip:c" },
        sourceFile: "a.html",
        binding: { sourceFile: "a.html", domId: "dom-c" },
      }),
    ]);
    expect(result.document.sequence.tracks[0]!.clips).toEqual([untouched]);
    expect(result.document.sequence.tracks[1]!.clips).toEqual([]);
    expect(result.document.assets).toEqual(original.assets);
    expect(result.document.canvas).toEqual(original.canvas);
    expect(result.document.revision).toBe(12);
    expect(JSON.stringify(original)).toBe(originalBytes);
  });

  it("collects one sorted source for multiple clips bound to the same file", () => {
    const result = planNativeTimelineDelete({ document: project(), targets: [targetB, targetA] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceFiles).toEqual(["z.html"]);
    expect(result.deletions.map((deletion) => deletion.address.clipId)).toEqual(["clip:b", "clip:a"]);
  });

  it("rejects duplicate exact resolutions without partially deleting", () => {
    const original = project();
    const before = JSON.stringify(original);
    const result = planNativeTimelineDelete({
      document: original,
      targets: [targetA, { sourceFile: "z.html", attributes: { "data-studio-clip-id": "clip:a" } }],
    });

    expect(result).toMatchObject({ ok: false, failure: { code: "duplicate-clip", targetIndex: 1 } });
    expect(JSON.stringify(original)).toBe(before);
  });

  it("rejects an ambiguous exact identity", () => {
    const original = project();
    const duplicate = {
      ...original,
      sequence: {
        ...original.sequence,
        tracks: original.sequence.tracks.map((track, index) =>
          index === 1
            ? { ...track, clips: [{ ...original.sequence.tracks[0]!.clips[0]!, binding: undefined }] }
            : track,
        ),
      },
    } as NativeProjectDocument;

    expect(planNativeTimelineDelete({
      document: duplicate,
      targets: [{ id: "clip:a", sourceFile: "z.html" }],
    })).toMatchObject({ ok: false, failure: { code: "ambiguous-clip" } });
  });

  it("rejects a mixed valid and unbound target set without mutation", () => {
    const original = project();
    const unbound = {
      ...original,
      sequence: {
        ...original.sequence,
        tracks: original.sequence.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => clip.id === "clip:b" ? { ...clip, binding: undefined } : clip),
        })),
      },
    } as NativeProjectDocument;
    const before = JSON.stringify(unbound);
    const result = planNativeTimelineDelete({
      document: unbound,
      targets: [targetA, { attributes: { "data-studio-clip-id": "clip:b" } }],
    });

    expect(result).toMatchObject({ ok: false, failure: { code: "unbound-clip", targetIndex: 1 } });
    expect(JSON.stringify(unbound)).toBe(before);
  });

  it.each([
    { structuralRole: "composition-root", sourceFile: "z.html", id: "root" },
    { sourceFile: "z.html", selector: '[data-composition-id="main"]' },
    { sourceFile: "z.html", attributes: { "data-composition-id": "main" }, id: "root" },
  ])("rejects a root-like target before native resolution", (target) => {
    expect(planNativeTimelineDelete({ document: project(), targets: [target] })).toMatchObject({
      ok: false,
      failure: { code: "protected-root" },
    });
  });

  it("rejects a selected source that disagrees with the durable binding", () => {
    expect(planNativeTimelineDelete({
      document: project(),
      targets: [{
        attributes: { "data-studio-clip-id": "clip:a" },
        sourceFile: "wrong.html",
      }],
    })).toMatchObject({ ok: false, failure: { code: "binding-source-mismatch" } });
  });

  it("rejects an empty target set", () => {
    expect(planNativeTimelineDelete({ document: project(), targets: [] })).toMatchObject({
      ok: false,
      failure: { code: "empty-target-set" },
    });
  });
});
