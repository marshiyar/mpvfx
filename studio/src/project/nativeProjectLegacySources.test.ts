import { describe, expect, it } from "vitest";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";

import type { TimelineElement } from "../player/store/timelineElement";
import { bootstrapNativeProjectFromTimeline } from "./nativeProjectBootstrap";
import {
  buildLegacyGsapNativeSources,
  type LegacyGsapAnimationFile,
} from "./nativeProjectLegacySources";

const frameRate = { numerator: 30, denominator: 1 } as const;
const element = (overrides: Partial<TimelineElement> = {}): TimelineElement => ({
  id: "timeline-camera",
  tag: "video",
  start: 0,
  duration: 2,
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

function animation(overrides: Partial<GsapAnimation> = {}): GsapAnimation {
  return {
    id: "legacy:rotation",
    targetSelector: "#camera-a",
    method: "fromTo",
    position: 0,
    resolvedStart: 0,
    duration: 1,
    properties: { rotation: -180 },
    fromProperties: { rotation: 0 },
    ...overrides,
  };
}

function fixture() {
  const timeline = [element()];
  const result = bootstrapNativeProjectFromTimeline({
    projectId: "project:legacy-sources",
    sequenceId: "sequence:main",
    sequenceName: "Main",
    frameRate,
    canvas: { width: 1920, height: 1080, background: "#000" },
    elements: timeline,
  });
  if (!result.ok) throw new Error("bootstrap fixture failed");
  return { timeline, document: result.document };
}

describe("native bootstrap GSAP source collection", () => {
  it("matches literal selector animations to the canonical clip binding", () => {
    const { timeline, document } = fixture();
    const files: LegacyGsapAnimationFile[] = [{
      sourceFile: "index.html",
      animations: [animation()],
    }];

    const result = buildLegacyGsapNativeSources(document, timeline, files);

    expect(result.unmatched).toEqual([]);
    expect(result.sources).toEqual([
      {
        clipId: document.sequence.tracks[0]!.clips[0]!.id,
        binding: document.sequence.tracks[0]!.clips[0]!.binding,
        animations: files[0]!.animations,
      },
    ]);
  });

  it("keeps dynamic selectors explicit instead of guessing a native clip", () => {
    const { timeline, document } = fixture();
    const dynamic = animation({ hasUnresolvedSelector: true, targetSelector: "selectorFromData" });
    const result = buildLegacyGsapNativeSources(document, timeline, [
      { sourceFile: "index.html", animations: [dynamic] },
    ]);

    expect(result.sources).toEqual([]);
    expect(result.unmatched).toEqual([
      expect.objectContaining({
        sourceFile: "index.html",
        animation: dynamic,
        reason: "dynamic-selector",
      }),
    ]);
  });

  it("is independent of timeline/file input ordering", () => {
    const first = fixture();
    const second = fixture();
    const extra = element({
      id: "timeline-second",
      domId: "camera-b",
      hfId: "hf-camera-b",
      selector: "#camera-b",
      src: "assets/second.mov",
    });
    const secondResult = bootstrapNativeProjectFromTimeline({
      projectId: "project:legacy-sources",
      sequenceId: "sequence:main",
      sequenceName: "Main",
      frameRate,
      canvas: { width: 1920, height: 1080, background: "#000" },
      elements: [extra, ...second.timeline],
    });
    if (!secondResult.ok) throw new Error("second bootstrap fixture failed");
    const files = [
      { sourceFile: "index.html", animations: [animation({ id: "legacy:b", targetSelector: "#camera-b" })] },
      { sourceFile: "index.html", animations: [animation({ id: "legacy:a" })] },
    ];

    const left = buildLegacyGsapNativeSources(secondResult.document, [extra, ...second.timeline], files);
    const right = buildLegacyGsapNativeSources(secondResult.document, [...second.timeline, extra], [...files].reverse());

    expect(left).toEqual(right);
    expect(first.document.sequence.tracks[0]!.clips[0]!.binding?.domId).toBe("camera-a");
  });
});
