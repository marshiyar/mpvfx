import { describe, expect, it } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import {
  planNativeTimelineAssetInsertions,
  quantizeNativeTimelineAssetInsertion,
  type NativeTimelineAssetInsertion,
} from "./nativeTimelineAssetInsertPlan";

const frameRate = { numerator: 30_000, denominator: 1_001 } as const;

function project(): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:insert",
    revision: 4,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#000" },
    assets: [{ id: "asset:existing", kind: "video", name: "existing.mov", durationFrames: 900 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "track:existing",
        kind: "video",
        lane: { authoredTrack: 0, displayTrack: 0 },
        clips: [{
          id: "clip:existing",
          assetId: "asset:existing",
          binding: { sourceFile: "index.html", domId: "existing", hfId: "hf-existing" },
          startFrame: 0,
          durationFrames: 60,
          sourceInFrame: 12,
          playbackRate: { numerator: 2, denominator: 1 },
          muted: true,
          staticParameters: { "visual.opacity": 0.4 },
          effects: [{ id: "fx:1", effectId: "blur", enabled: true }],
          parameterTracks: [],
        }],
      }],
    },
  });
}

const insertion = (
  overrides: Partial<NativeTimelineAssetInsertion> = {},
): NativeTimelineAssetInsertion => ({
  assetPath: "media/new.mov",
  kind: "video",
  sourceFile: "index.html",
  binding: { sourceFile: "index.html", domId: "new", hfId: "hf-new" },
  requestedStartSeconds: (90 * frameRate.denominator) / frameRate.numerator,
  requestedDurationSeconds: (120 * frameRate.denominator) / frameRate.numerator,
  sourceDurationSeconds: (300 * frameRate.denominator) / frameRate.numerator,
  requestedTrack: 0,
  ...overrides,
});

describe("native timeline asset insertion planner", () => {
  it("quantizes fractional-rate time to exact integer frames and compatibility seconds", () => {
    const result = quantizeNativeTimelineAssetInsertion(project(), insertion({
      requestedStartSeconds: 3.003,
      requestedDurationSeconds: 2.002,
      sourceDurationSeconds: 10.01,
    }));

    expect(result).toEqual({
      ok: true,
      startFrame: 90,
      durationFrames: 60,
      sourceDurationFrames: 300,
      compatibilityStartSeconds: 3.003,
      compatibilityDurationSeconds: 2.002,
    });
  });

  it("adds video, audio, and image clips with deterministic IDs and native defaults", () => {
    const input = [
      insertion(),
      insertion({
        assetPath: "media/voice.wav",
        kind: "audio",
        binding: { sourceFile: "index.html", domId: "voice" },
        requestedTrack: 2,
      }),
      insertion({
        assetPath: "media/poster.png",
        kind: "image",
        binding: { sourceFile: "index.html", domId: "poster" },
        requestedTrack: 4,
      }),
    ];
    const result = planNativeTimelineAssetInsertions({ document: project(), insertions: input });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.insertions.map((entry) => entry.assetId)).toEqual([
      "native-asset:video:13:media/new.mov",
      "native-asset:audio:15:media/voice.wav",
      "native-asset:image:16:media/poster.png",
    ]);
    const addedClips = result.document.sequence.tracks
      .flatMap((track) => track.clips)
      .filter((clip) => clip.id !== "clip:existing");
    expect(addedClips).toHaveLength(3);
    expect(addedClips).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceInFrame: 0,
        playbackRate: { numerator: 1, denominator: 1 },
        muted: false,
        staticParameters: {},
        effects: [],
        parameterTracks: [],
      }),
    ]));
    expect(result.document.sequence.tracks.map((track) => [track.kind, track.lane])).toEqual([
      ["video", { authoredTrack: 0, displayTrack: 0 }],
      ["audio", { authoredTrack: 2, displayTrack: 2 }],
      ["video", { authoredTrack: 4, displayTrack: 4 }],
    ]);
  });

  it("reuses a compatible lane and creates deterministic sparse tracks", () => {
    const first = planNativeTimelineAssetInsertions({
      document: project(),
      insertions: [insertion(), insertion({
        assetPath: "media/sparse.mov",
        binding: { sourceFile: "index.html", domId: "sparse" },
        requestedTrack: 8,
      })],
    });
    const reversed = planNativeTimelineAssetInsertions({
      document: project(),
      insertions: [insertion({
        assetPath: "media/sparse.mov",
        binding: { sourceFile: "index.html", domId: "sparse" },
        requestedTrack: 8,
      }), insertion()],
    });
    expect(first.ok).toBe(true);
    expect(reversed.ok).toBe(true);
    if (!first.ok || !reversed.ok) return;
    expect(first.document).toEqual(reversed.document);
    expect(first.document.sequence.tracks.find((track) => track.lane?.authoredTrack === 8)?.id)
      .toBe("native-track:8:video");
    expect(first.document.sequence.tracks.filter((track) => track.lane?.authoredTrack === 0))
      .toHaveLength(1);
  });

  it("reuses one asset identity and grows only its source duration", () => {
    const first = insertion();
    const second = insertion({
      binding: { sourceFile: "index.html", domId: "new-2" },
      requestedStartSeconds: 8,
      sourceDurationSeconds: 20,
    });
    const result = planNativeTimelineAssetInsertions({ document: project(), insertions: [first, second] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const assets = result.document.assets.filter((asset) => asset.name === "new.mov");
    expect(assets).toEqual([expect.objectContaining({ durationFrames: 599 })]);
  });

  it("preserves every existing asset, effect, static value, timing, binding, and mute value", () => {
    const before = project();
    const result = planNativeTimelineAssetInsertions({ document: before, insertions: [insertion()] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.assets[0]).toEqual(before.assets[0]);
    expect(result.document.sequence.tracks[0]?.clips.find((clip) => clip.id === "clip:existing"))
      .toEqual(before.sequence.tracks[0]?.clips[0]);
    expect(result.document.revision).toBe(before.revision);
  });

  it.each([
    ["empty-batch", [], "empty-insertion-set"],
    ["negative time", [insertion({ requestedStartSeconds: -1 })], "invalid-time"],
    ["subframe duration", [insertion({ requestedDurationSeconds: 0.001 })], "invalid-duration"],
    ["short source", [insertion({ sourceDurationSeconds: 1 })], "source-out-of-bounds"],
    ["invalid lane", [insertion({ requestedTrack: 1.5 })], "invalid-track"],
    ["invalid binding", [insertion({ binding: { sourceFile: "index.html" } })], "invalid-binding"],
    ["source mismatch", [insertion({ binding: { sourceFile: "other.html", domId: "new" } })], "binding-source-mismatch"],
    ["duplicate existing binding", [insertion({ binding: { sourceFile: "index.html", domId: "existing" } })], "binding-collision"],
    ["duplicate batch binding", [insertion(), insertion()], "binding-collision"],
  ] as const)("rejects %s without mutating the input", (_label, insertions, code) => {
    const before = project();
    const snapshot = JSON.stringify(before);
    const result = planNativeTimelineAssetInsertions({ document: before, insertions });
    expect(result).toMatchObject({ ok: false, failure: { code } });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("rejects an occupied lane whose media kind is incompatible", () => {
    const result = planNativeTimelineAssetInsertions({
      document: project(),
      insertions: [insertion({
        assetPath: "media/voice.wav",
        kind: "audio",
        binding: { sourceFile: "index.html", domId: "voice" },
        requestedTrack: 0,
      })],
    });
    expect(result).toMatchObject({ ok: false, failure: { code: "incompatible-lane" } });
  });

  it("rejects deterministic asset, clip, and track identity collisions", () => {
    const base = project();
    const collidingTrack = parseNativeProjectDocument({
      ...base,
      sequence: {
        ...base.sequence,
        tracks: [...base.sequence.tracks, {
          id: "native-track:8:video",
          kind: "video",
          lane: { authoredTrack: 7, displayTrack: 7 },
          clips: [],
        }],
      },
    });
    const result = planNativeTimelineAssetInsertions({
      document: collidingTrack,
      insertions: [insertion({ requestedTrack: 8 })],
    });
    expect(result).toMatchObject({ ok: false, failure: { code: "identity-collision" } });
  });
});
