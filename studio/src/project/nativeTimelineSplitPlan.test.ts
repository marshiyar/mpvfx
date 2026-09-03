import { describe, expect, it } from "vitest";

import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
  type NativeProjectDocument,
} from "./nativeProjectDocument";
import { planNativeTimelineSplits } from "./nativeTimelineSplitPlan";

const frameRate = { numerator: 30_000, denominator: 1_001 } as const;

function project(): NativeProjectDocument {
  return parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:split",
    revision: 3,
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    assets: [
      { id: "asset:a", kind: "video", name: "a.mov", durationFrames: 900 },
      { id: "asset:b", kind: "video", name: "b.mov", durationFrames: 900 },
    ],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [{
        id: "track:video",
        kind: "video",
        lane: { authoredTrack: 2, displayTrack: 0 },
        clips: [{
          id: "native:a",
          assetId: "asset:a",
          binding: { sourceFile: "a.html", domId: "clip" },
          startFrame: 30,
          durationFrames: 120,
          sourceInFrame: 12,
          playbackRate: { numerator: 2, denominator: 1 },
          muted: true,
          staticParameters: { opacity: 0.65, "transform.rotation": 15 },
          effects: [{ id: "fx:grade", effectId: "grade", enabled: true, parameters: { exposure: 0.2 } }],
          parameterTracks: [{
            schemaVersion: 1,
            id: "rotation:a",
            parameterId: "transform.rotation",
            valueType: "number",
            frameRate,
            keyframes: [
              { id: "r0", frame: 0, value: 0, outgoing: { type: "linear" } },
              { id: "r1", frame: 60, value: 180, outgoing: { type: "hold" } },
            ],
          }],
        }, {
          id: "native:b",
          assetId: "asset:b",
          binding: { sourceFile: "b.html", domId: "other" },
          startFrame: 180,
          durationFrames: 90,
          sourceInFrame: 4,
          muted: false,
          staticParameters: {},
          effects: [],
          parameterTracks: [],
        }],
      }],
    },
  });
}

const first = {
  element: { id: "clip", sourceFile: "a.html" },
  requestedSplitSeconds: (60 * frameRate.denominator) / frameRate.numerator,
  rightBinding: { sourceFile: "a.html", domId: "clip-split-2" },
} as const;

describe("native timeline split planner", () => {
  it("splits at an exact 30000/1001 project frame and preserves all clip-local state", () => {
    const original = project();
    const before = JSON.stringify(original);
    const result = planNativeTimelineSplits({ document: original, splits: [first] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.splits).toEqual([expect.objectContaining({
      splitFrame: 60,
      compatibilitySplitSeconds: (60 * frameRate.denominator) / frameRate.numerator,
      compatibilitySplitTime: "2.002",
      sourceFile: "a.html",
      leftBinding: { sourceFile: "a.html", domId: "clip" },
      rightBinding: { sourceFile: "a.html", domId: "clip-split-2" },
    })]);

    const [left, right] = result.document.sequence.tracks[0]!.clips;
    expect(left).toMatchObject({
      id: "native:a",
      startFrame: 30,
      durationFrames: 30,
      sourceInFrame: 12,
      playbackRate: { numerator: 2, denominator: 1 },
      muted: true,
      staticParameters: { opacity: 0.65, "transform.rotation": 15 },
      effects: [{ id: "fx:grade", effectId: "grade", enabled: true, parameters: { exposure: 0.2 } }],
      binding: { sourceFile: "a.html", domId: "clip" },
    });
    expect(right).toMatchObject({
      startFrame: 60,
      durationFrames: 90,
      sourceInFrame: 72,
      playbackRate: { numerator: 2, denominator: 1 },
      muted: true,
      staticParameters: { opacity: 0.65, "transform.rotation": 15 },
      effects: [{ id: "fx:grade", effectId: "grade", enabled: true, parameters: { exposure: 0.2 } }],
      binding: { sourceFile: "a.html", domId: "clip-split-2" },
    });
    expect(left!.parameterTracks[0]!.keyframes).toEqual([
      expect.objectContaining({ frame: 0, value: 0 }),
    ]);
    expect(right!.parameterTracks[0]!.keyframes[0]).toMatchObject({ frame: 0, value: 90 });
    expect(JSON.stringify(original)).toBe(before);
  });

  it("plans multiple source files as one all-or-nothing native edit", () => {
    const result = planNativeTimelineSplits({
      document: project(),
      splits: [first, {
        element: { id: "other", sourceFile: "b.html" },
        requestedSplitSeconds: (210 * frameRate.denominator) / frameRate.numerator,
        rightBinding: { sourceFile: "b.html", domId: "other-split" },
      }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceFiles).toEqual(["a.html", "b.html"]);
    expect(result.document.sequence.tracks[0]!.clips).toHaveLength(4);
  });

  it.each([
    ["empty batch", [], "empty-split-set"],
    ["expanded child", [{ ...first, element: { ...first.element, expandedParentStart: 2 } }], "ambiguous-local-time"],
    ["nested child", [{ ...first, element: { ...first.element, parentCompositionId: "scene" } }], "ambiguous-local-time"],
    ["edge no-op", [{ ...first, requestedSplitSeconds: (30 * frameRate.denominator) / frameRate.numerator }], "native-command-rejected"],
    ["unbound selection", [{ ...first, element: { attributes: { "data-studio-clip-id": "native:a" } }, rightBinding: { sourceFile: "a.html", domId: "new" } }], "binding-source-mismatch"],
    ["wrong right source", [{ ...first, rightBinding: { sourceFile: "b.html", domId: "new" } }], "right-binding-source-mismatch"],
  ])("rejects %s without mutating the document", (_label, splits, code) => {
    const original = project();
    const before = JSON.stringify(original);
    const result = planNativeTimelineSplits({ document: original, splits: splits as never });
    expect(result).toMatchObject({ ok: false, failure: { code } });
    expect(JSON.stringify(original)).toBe(before);
  });

  it("rejects duplicate resolved clips before applying any split", () => {
    const original = project();
    const result = planNativeTimelineSplits({
      document: original,
      splits: [first, {
        ...first,
        element: { attributes: { "data-studio-clip-id": "native:a" }, sourceFile: "a.html" },
        rightBinding: { sourceFile: "a.html", domId: "another-right" },
      }],
    });
    expect(result).toMatchObject({ ok: false, failure: { code: "duplicate-clip" } });
    expect(original.sequence.tracks[0]!.clips).toHaveLength(2);
  });
});
