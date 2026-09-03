import { describe, expect, it } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { planNativeTimelineRangeEdit } from "./nativeTimelineRangeEditPlan";

const frameRate = { numerator: 30_000, denominator: 1_001 } as const;

function document(options?: {
  playbackRate?: { numerator: number; denominator: number };
  binding?: boolean;
}): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:range",
    revision: 4,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#101010" },
    assets: [{ id: "asset:a", kind: "video", name: "a.mov", durationFrames: 900 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "track:v1",
        kind: "video",
        clips: [{
          id: "clip:a",
          assetId: "asset:a",
          ...(options?.binding === false
            ? {}
            : { binding: { sourceFile: "index.html", domId: "clip", hfId: "hf-clip" } }),
          startFrame: 30,
          durationFrames: 120,
          sourceInFrame: 10,
          playbackRate: options?.playbackRate ?? { numerator: 2, denominator: 1 },
          muted: true,
          staticParameters: { opacity: 0.75 },
          effects: [{ id: "fx:1", effectId: "blur", enabled: true }],
          parameterTracks: [{
            schemaVersion: 1,
            id: "param:rotation",
            parameterId: "rotation",
            valueType: "number",
            frameRate,
            keyframes: [
              { id: "key:0", frame: 0, value: 0, outgoing: { type: "linear" } },
              { id: "key:1", frame: 60, value: 180, outgoing: { type: "linear" } },
              { id: "key:2", frame: 90, value: 270, outgoing: { type: "hold" } },
            ],
          }],
        }],
      }],
    },
  });
}

const element = {
  id: "clip",
  domId: "clip",
  hfId: "hf-clip",
  sourceFile: "index.html",
  selector: "#clip",
  selectorIndex: 0,
};

const secondsAtFrame = (frame: number) => (frame * frameRate.denominator) / frameRate.numerator;

describe("native timeline range edit planner", () => {
  it("makes trim-in frames canonical and derives exact compatibility timing after playback-rate source math", () => {
    const result = planNativeTimelineRangeEdit({
      document: document(),
      element,
      requestedStartSeconds: secondsAtFrame(45) + 1e-12,
      requestedDurationSeconds: secondsAtFrame(105) + 1e-12,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("trim-in");
    expect(result.address).toEqual({
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:a",
    });
    expect(result.compatibility).toEqual({
      start: String(secondsAtFrame(45)),
      duration: String(secondsAtFrame(105)),
      sourceOffset: String(secondsAtFrame(40)),
    });

    const trimmed = result.document.sequence.tracks[0]!.clips[0]!;
    expect(trimmed).toMatchObject({
      startFrame: 45,
      durationFrames: 105,
      sourceInFrame: 40,
      playbackRate: { numerator: 2, denominator: 1 },
      muted: true,
      staticParameters: { opacity: 0.75 },
      effects: [{ id: "fx:1", effectId: "blur", enabled: true }],
      binding: { sourceFile: "index.html", domId: "clip", hfId: "hf-clip" },
    });
    expect(trimmed.parameterTracks[0]!.keyframes).toMatchObject([
      { frame: 0, value: 45, outgoing: { type: "linear" } },
      { id: "key:1", frame: 45, value: 180 },
      { id: "key:2", frame: 75, value: 270 },
    ]);
  });

  it("plans trim-out without changing the native source offset or clip-local state", () => {
    const result = planNativeTimelineRangeEdit({
      document: document(),
      element,
      requestedStartSeconds: secondsAtFrame(30),
      requestedDurationSeconds: secondsAtFrame(60),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("trim-out");
    expect(result.compatibility).toEqual({
      start: String(secondsAtFrame(30)),
      duration: String(secondsAtFrame(60)),
      sourceOffset: String(secondsAtFrame(10)),
    });
    expect(result.document.sequence.tracks[0]!.clips[0]).toMatchObject({
      sourceInFrame: 10,
      muted: true,
      staticParameters: { opacity: 0.75 },
      effects: [{ id: "fx:1", effectId: "blur", enabled: true }],
      binding: { sourceFile: "index.html", domId: "clip", hfId: "hf-clip" },
    });
  });

  it("declines an unbound native clip instead of inventing a compatibility target", () => {
    const result = planNativeTimelineRangeEdit({
      document: document({ binding: false }),
      element: {
        ...element,
        sourceFile: undefined,
        dataset: { studioClipId: "clip:a" },
      },
      requestedStartSeconds: secondsAtFrame(30),
      requestedDurationSeconds: secondsAtFrame(60),
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        code: "unbound-clip",
        message: "Native clip clip:a has no exact compatibility binding",
      },
    });
  });

  it("declines a missing native clip without mutating the supplied document", () => {
    const original = document();
    const result = planNativeTimelineRangeEdit({
      document: original,
      element: {
        ...element,
        id: "missing",
        domId: "missing",
        hfId: "missing",
        selector: "#missing",
      },
      requestedStartSeconds: secondsAtFrame(30),
      requestedDurationSeconds: secondsAtFrame(60),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("clip-not-found");
    expect(original.sequence.tracks[0]!.clips[0]).toMatchObject({
      startFrame: 30,
      durationFrames: 120,
      sourceInFrame: 10,
    });
  });

  it("rejects a trim boundary that cannot map to an integral source frame", () => {
    const result = planNativeTimelineRangeEdit({
      document: document({ playbackRate: { numerator: 3, denominator: 2 } }),
      element,
      requestedStartSeconds: secondsAtFrame(31),
      requestedDurationSeconds: secondsAtFrame(119),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("native-command-rejected");
    expect(result.failure.nativeCode).toBe("non-integral-source-boundary");
  });

  it("declines a range edit that moves both clip boundaries", () => {
    const result = planNativeTimelineRangeEdit({
      document: document(),
      element,
      requestedStartSeconds: secondsAtFrame(45),
      requestedDurationSeconds: secondsAtFrame(90),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("unsupported-range-change");
  });
});
