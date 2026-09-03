import { describe, expect, it } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { planNativeTimelineClipMove } from "./nativeTimelineClipMovePlan";

const frameRate = { numerator: 30_000, denominator: 1_001 } as const;

function document(): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:move",
    revision: 7,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#101010" },
    assets: [{ id: "asset:a", kind: "video", name: "a.mov", durationFrames: 900 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [
        {
          id: "opaque-source-track",
          kind: "video",
          lane: { authoredTrack: 7, displayTrack: 2 },
          clips: [
            {
              id: "clip:a",
              assetId: "asset:a",
              binding: { sourceFile: "index.html", domId: "clip", hfId: "hf-clip" },
              startFrame: 30,
              durationFrames: 120,
              sourceInFrame: 12,
              muted: false,
              staticParameters: { opacity: 0.75 },
              effects: [{ id: "fx:1", effectId: "blur", enabled: true }],
              parameterTracks: [
                {
                  schemaVersion: 1,
                  id: "param:rotation",
                  parameterId: "rotation",
                  valueType: "number",
                  frameRate,
                  keyframes: [
                    { id: "key:0", frame: 0, value: 0, outgoing: { type: "linear" } },
                    { id: "key:1", frame: 60, value: 180, outgoing: { type: "linear" } },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: "target-without-lane-in-id",
          kind: "video",
          lane: { authoredTrack: 19, displayTrack: 3 },
          clips: [],
        },
        {
          id: "audio-target-without-lane-in-id",
          kind: "audio",
          lane: { authoredTrack: 23, displayTrack: 4 },
          clips: [],
        },
      ],
    },
  });
}

const element = {
  id: "timeline-row",
  domId: "clip",
  hfId: "hf-clip",
  sourceFile: "index.html",
  selector: "#clip",
  selectorIndex: 0,
  currentTrack: 2,
};

describe("native timeline clip move planner", () => {
  it("makes the integer native project frame canonical and derives compatibility seconds from it", () => {
    const result = planNativeTimelineClipMove({
      document: document(),
      element,
      requestedStartSeconds: (75.99 * frameRate.denominator) / frameRate.numerator,
      requestedTrack: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.address).toEqual({
      sequenceId: "sequence:main",
      trackId: "opaque-source-track",
      clipId: "clip:a",
    });
    expect(result.destination).toEqual({
      trackId: "opaque-source-track",
      authoredTrack: 7,
      displayTrack: 2,
    });
    expect(result.startFrame).toBe(75);
    expect(result.compatibilityStartSeconds).toBe((75 * 1_001) / 30_000);
    const moved = result.document.sequence.tracks[0]!.clips[0]!;
    expect(moved.startFrame).toBe(75);
    expect(moved).toMatchObject({
      sourceInFrame: 12,
      muted: false,
      staticParameters: { opacity: 0.75 },
      effects: [{ id: "fx:1", effectId: "blur", enabled: true }],
    });
    expect(moved.parameterTracks[0]!.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 60]);
  });

  it("moves to a mapped compatible authored lane and returns both lane coordinates for the HTML mirror", () => {
    const original = document();
    const before = original.sequence.tracks[0]!.clips[0]!;
    const result = planNativeTimelineClipMove({
      document: original,
      element,
      requestedStartSeconds: 3,
      requestedTrack: 19,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.destination).toEqual({
      trackId: "target-without-lane-in-id",
      authoredTrack: 19,
      displayTrack: 3,
    });
    expect(result.document.sequence.tracks[0]!.clips).toEqual([]);
    expect(result.document.sequence.tracks[1]!.clips[0]).toMatchObject({
      ...before,
      startFrame: 89,
    });
  });

  it.each([
    ["the destination's display-only lane number", 3],
    ["an unmapped authored lane", 9],
    ["an incompatible audio authored lane", 23],
  ])("rejects %s without mutating the native document", (_name, requestedTrack) => {
    const original = document();
    const before = JSON.stringify(original);
    const result = planNativeTimelineClipMove({
      document: original,
      element,
      requestedStartSeconds: 3,
      requestedTrack,
    });

    expect(result).toEqual({
      ok: false,
      failure: {
        code: "unsupported-lane-change",
        message: expect.stringContaining("mapped compatible native track"),
      },
    });
    expect(original.sequence.tracks[0]!.clips[0]!.startFrame).toBe(30);
    expect(JSON.stringify(original)).toBe(before);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01])(
    "rejects invalid requested time without changing the document: %s",
    (requestedStartSeconds) => {
      const original = document();
      const result = planNativeTimelineClipMove({
        document: original,
        element,
        requestedStartSeconds,
        requestedTrack: 2,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe("invalid-start");
      expect(original.sequence.tracks[0]!.clips[0]!.startFrame).toBe(30);
    },
  );

  it("rejects an unbound timeline element instead of guessing a native clip", () => {
    const result = planNativeTimelineClipMove({
      document: document(),
      element: { ...element, domId: "other", hfId: "other", selector: "#other" },
      requestedStartSeconds: 2,
      requestedTrack: 2,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("clip-not-found");
  });
});
