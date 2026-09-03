import { describe, expect, it } from "vitest";

import { createNativeParameterTrack } from "../../project/nativeKeyframeTypes";
import {
  NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
  parseNativeProjectDocument,
} from "../../project/nativeProjectDocument";
import type { TimelineElement } from "../store/playerStore";
import {
  buildNativeTimelineLaneProjectionMap,
  nativeTimelineLaneCounts,
  nativeTimelinePropertyLanesForElement,
} from "./nativeTimelinePropertyLaneBridge";

const documentFixture = () =>
  parseNativeProjectDocument({
    schemaVersion: NATIVE_PROJECT_DOCUMENT_SCHEMA_VERSION,
    id: "project:timeline",
    revision: 2,
    frameRate: { numerator: 30, denominator: 1 },
    canvas: { width: 1920, height: 1080, background: "#111111" },
    assets: [{ id: "asset:video", kind: "video", name: "hero.mp4", durationFrames: 300 }],
    sequence: {
      id: "sequence:main",
      name: "Main",
      tracks: [
        {
          id: "track:v1",
          kind: "video",
          clips: [
            {
              id: "clip:hero",
              assetId: "asset:video",
              startFrame: 30,
              durationFrames: 120,
              sourceInFrame: 0,
              muted: false,
              effects: [],
              binding: {
                sourceFile: "index.html",
                domId: "hero-preview",
                hfId: "hf-hero",
                selector: "#hero-preview",
                selectorIndex: 0,
              },
              parameterTracks: [
                createNativeParameterTrack({
                  id: "parameter:rotation",
                  parameterId: "transform.rotation",
                  valueType: "number",
                  frameRate: { numerator: 30, denominator: 1 },
                  keyframes: [
                    { id: "rotation:0", frame: 0, value: 0, outgoing: { type: "linear" } },
                    { id: "rotation:60", frame: 60, value: -180, outgoing: { type: "hold" } },
                  ],
                }),
                createNativeParameterTrack({
                  id: "parameter:opacity",
                  parameterId: "visual.opacity",
                  valueType: "number",
                  frameRate: { numerator: 30, denominator: 1 },
                  keyframes: [
                    { id: "opacity:0", frame: 0, value: 1, outgoing: { type: "linear" } },
                  ],
                }),
              ],
            },
          ],
        },
      ],
    },
  });

const timelineElement: TimelineElement = {
  id: "hero-preview",
  key: "index.html#hero-preview",
  hfId: "hf-hero",
  sourceFile: "index.html",
  selector: "#hero-preview",
  selectorIndex: 0,
  tag: "video",
  start: 1,
  duration: 4,
  track: 0,
};

describe("native timeline property lane bridge", () => {
  it("maps native project groups to timeline chrome without fabricating GSAP animations", () => {
    const projection = nativeTimelinePropertyLanesForElement(documentFixture(), timelineElement);

    expect(projection?.clipId).toBe("clip:hero");
    expect(projection?.lanes.map(({ id, propertyGroup }) => [id, propertyGroup])).toEqual([
      ["parameter:rotation", "rotation"],
      ["parameter:opacity", "visual"],
    ]);
    expect(projection?.lanes[0]?.keyframes[1]).toEqual({
      id: "rotation:60",
      percentage: 50,
      properties: { rotation: -180 },
      native: {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:hero",
        parameterId: "transform.rotation",
        keyframeId: "rotation:60",
        frame: 60,
        clipDurationFrames: 120,
        hasFollowingKeyframe: false,
        properties: { rotation: -180 },
        outgoing: { type: "hold" },
      },
    });
  });

  it("marks only diamonds with a following key as eligible for outgoing interpolation", () => {
    const rotation = nativeTimelinePropertyLanesForElement(documentFixture(), timelineElement)
      ?.lanes.find((lane) => lane.id === "parameter:rotation");
    expect(rotation?.keyframes.map((keyframe) => keyframe.native?.hasFollowingKeyframe)).toEqual([
      true,
      false,
    ]);
  });

  it("returns null when exact scoped identity cannot resolve a native clip", () => {
    expect(
      nativeTimelinePropertyLanesForElement(documentFixture(), {
        ...timelineElement,
        id: "unknown",
        hfId: undefined,
        selector: undefined,
      }),
    ).toBeNull();
  });

  it("builds source-scoped projection and distinct-group count maps for timeline layout", () => {
    const unknown = {
      ...timelineElement,
      id: "unknown",
      key: "index.html#unknown",
      hfId: undefined,
      selector: undefined,
    };
    const projections = buildNativeTimelineLaneProjectionMap(documentFixture(), [
      timelineElement,
      unknown,
    ]);

    expect([...projections.keys()]).toEqual(["index.html#hero-preview"]);
    expect(nativeTimelineLaneCounts(projections)).toEqual(
      new Map([["index.html#hero-preview", 2]]),
    );
  });
});
