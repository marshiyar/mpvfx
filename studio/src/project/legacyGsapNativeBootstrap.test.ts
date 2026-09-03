import { describe, expect, it } from "vitest";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";

import type { TimelineElement } from "../player/store/timelineElement";
import { bootstrapNativeProjectFromTimeline } from "./nativeProjectBootstrap";
import {
  createNativeParameterTrack,
  type NativeParameterTrack,
} from "./nativeKeyframeTypes";
import {
  mergeLegacyGsapAnimationsIntoNativeProject,
  type LegacyGsapNativeBootstrapSource,
} from "./legacyGsapNativeBootstrap";
import {
  parseNativeProjectDocument,
  serializeNativeProjectDocument,
} from "./nativeProjectDocument";

const frameRate = { numerator: 30, denominator: 1 } as const;

const element = (overrides: Partial<TimelineElement> = {}): TimelineElement => ({
  id: "runtime-row",
  tag: "video",
  start: 1,
  duration: 3,
  track: 0,
  authoredTrack: 0,
  sourceFile: "index.html",
  domId: "camera-a",
  hfId: "hf-camera-a",
  selector: "#camera-a",
  selectorIndex: 0,
  src: "assets/camera.mov",
  ...overrides,
});

function baseDocument() {
  const result = bootstrapNativeProjectFromTimeline({
    projectId: "project:legacy-merge",
    sequenceId: "sequence:main",
    sequenceName: "Main",
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    elements: [element()],
  });
  if (!result.ok) throw new Error("bootstrap fixture failed");
  return result.document;
}

function clipOf(document: ReturnType<typeof baseDocument>) {
  const clip = document.sequence.tracks[0]?.clips[0];
  if (!clip) throw new Error("bootstrap fixture has no clip");
  return clip;
}

function animation(overrides: Partial<GsapAnimation> = {}): GsapAnimation {
  return {
    id: "legacy:rotation",
    targetSelector: "#camera-a",
    method: "fromTo",
    position: 0,
    resolvedStart: 1,
    duration: 2,
    properties: { rotation: -180 },
    fromProperties: { rotation: 0 },
    ...overrides,
  };
}

function source(
  document: ReturnType<typeof baseDocument>,
  animations: readonly GsapAnimation[],
): LegacyGsapNativeBootstrapSource {
  const clip = clipOf(document);
  return { binding: clip.binding, animations };
}

function addOwnedTrack(
  document: ReturnType<typeof baseDocument>,
  track: NativeParameterTrack,
) {
  const clip = clipOf(document);
  return parseNativeProjectDocument({
    ...document,
    sequence: {
      ...document.sequence,
      tracks: document.sequence.tracks.map((timelineTrack) => ({
        ...timelineTrack,
        clips: timelineTrack.clips.map((candidate) =>
          candidate.id === clip.id
            ? { ...candidate, parameterTracks: [...candidate.parameterTracks, track] }
            : candidate,
        ),
      })),
    },
  });
}

describe("legacy GSAP native bootstrap merger", () => {
  it("imports exact animations through the clip binding and produces stable local tracks", () => {
    const document = baseDocument();
    const clip = clipOf(document);
    const result = mergeLegacyGsapAnimationsIntoNativeProject({
      document,
      sources: [
        source(document, [
          animation({ id: "legacy:position", properties: { x: 0 }, fromProperties: { x: 100 } }),
          animation({ id: "legacy:rotation" }),
        ]),
      ],
    });

    expect(result.legacyOnly).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.document.sequence.tracks[0]?.clips[0]?.id).toBe(clip.id);
    expect(result.document.sequence.tracks[0]?.clips[0]?.parameterTracks).toMatchObject([
      {
        parameterId: "transform.position.x",
        keyframes: [
          { frame: 0, value: 100 },
          { frame: 60, value: 0 },
        ],
      },
      {
        parameterId: "transform.rotation",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: 60, value: -180 },
        ],
      },
    ]);
    expect(result.importedTrackIds.every((id) => id.includes(clip.id))).toBe(true);
  });

  it.each([
    ["dynamic keyframes", { hasUnresolvedKeyframes: true }, "dynamic-keyframes"],
    ["dynamic selector", { hasUnresolvedSelector: true }, "dynamic-selector"],
    ["plugin animation", { arcPath: { enabled: true, autoRotate: false, segments: [] } }, "unsupported-plugin-or-extra"],
  ] as const)("keeps %s legacy-only with an explicit diagnostic", (_label, overrides, reason) => {
    const document = baseDocument();
    const legacy = animation(overrides);
    const result = mergeLegacyGsapAnimationsIntoNativeProject({
      document,
      sources: [source(document, [legacy])],
    });

    expect(result.document).toEqual(document);
    expect(result.legacyOnly).toEqual([{ clipId: clipOf(document).id, animation: legacy }]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        clipId: clipOf(document).id,
        animationId: legacy.id,
        reason,
        disposition: "legacy-only",
      }),
    );
  });

  it("never overwrites an existing native owner for a parameter", () => {
    const original = baseDocument();
    const clip = clipOf(original);
    const existing = createNativeParameterTrack({
      id: "native:existing:rotation",
      parameterId: "transform.rotation",
      valueType: "number",
      frameRate,
      keyframes: [
        { id: "existing:0", frame: 0, value: 12, outgoing: { type: "linear" } },
        { id: "existing:60", frame: 60, value: 24, outgoing: { type: "linear" } },
      ],
    });
    const document = addOwnedTrack(original, existing);
    const result = mergeLegacyGsapAnimationsIntoNativeProject({
      document,
      sources: [source(document, [animation()])],
    });

    expect(result.document).toEqual(document);
    expect(result.legacyOnly).toEqual([{ clipId: clip.id, animation: animation() }]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        reason: "native-parameter-already-owned",
        parameterId: "transform.rotation",
      }),
    );
  });

  it("is deterministic across source order and idempotent after the first merge", () => {
    const firstBase = baseDocument();
    const firstSources = [
      source(firstBase, [animation({ id: "legacy:z", properties: { x: 0 }, fromProperties: { x: 10 } })]),
      source(firstBase, [animation({ id: "legacy:a" })]),
    ];
    const first = mergeLegacyGsapAnimationsIntoNativeProject({
      document: firstBase,
      sources: firstSources,
    });

    const secondBase = baseDocument();
    const second = mergeLegacyGsapAnimationsIntoNativeProject({
      document: secondBase,
      sources: [...firstSources].reverse().map((entry) => ({
        ...entry,
        animations: [...entry.animations].reverse(),
      })),
    });

    expect(serializeNativeProjectDocument(first.document)).toBe(
      serializeNativeProjectDocument(second.document),
    );

    const repeated = mergeLegacyGsapAnimationsIntoNativeProject({
      document: first.document,
      sources: firstSources,
    });
    expect(serializeNativeProjectDocument(repeated.document)).toBe(
      serializeNativeProjectDocument(first.document),
    );
    expect(repeated.importedTrackIds).toEqual([]);
    expect(repeated.legacyOnly).toEqual([]);
    expect(repeated.diagnostics).toEqual([]);
  });
});
