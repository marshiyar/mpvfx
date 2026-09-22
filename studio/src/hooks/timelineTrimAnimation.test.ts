// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseAutomation, sampleAutomationLane } from "@hyperframes/core/audio-automation";
import { buildTimelineResizeTimingPatch } from "./timelineEditingHelpers";
import type { TimelineElement } from "../player";
it("trims audio without changing its envelope, and recovers hidden points when extended", () => {
  const automation = {
    version: 1,
    lanes: [
      {
        target: "volume",
        points: [
          { t: 0, v: 0.1, curve: 0.7 },
          { t: 8, v: 1 },
        ],
      },
    ],
  };
  const html = `<div data-composition-id="main" data-duration="10"><audio id="a" src="a.wav" data-start="1" data-duration="8" data-media-start="0" data-automation='${JSON.stringify(automation)}'></audio></div>`;
  const element: TimelineElement = {
    id: "a",
    tag: "audio",
    start: 1,
    duration: 8,
    track: 0,
    playbackStart: 0,
  };
  const trimmed = buildTimelineResizeTimingPatch(html, { id: "a" }, element, {
    start: 3,
    duration: 5,
    playbackStart: 2,
  });
  const read = (s: string) =>
    parseAutomation(
      new DOMParser()
        .parseFromString(s, "text/html")
        .getElementById("a")!
        .getAttribute("data-automation")!,
    );
  const lane = read(trimmed).lanes[0]!;
  expect(lane.points).toEqual([
    { ...automation.lanes[0]!.points[0], t: -2 },
    { t: 6, v: 1 },
  ]);
  for (let i = 0; i < 150; i++)
    expect(sampleAutomationLane(lane, i / 30)).toBeCloseTo(
      sampleAutomationLane(automation.lanes[0]!, i / 30 + 2),
      10,
    );
  const extended = buildTimelineResizeTimingPatch(
    trimmed,
    { id: "a" },
    { ...element, start: 3, duration: 5, playbackStart: 2 },
    { start: 1, duration: 8, playbackStart: 0 },
  );
  expect(read(extended)).toEqual(automation);
});
