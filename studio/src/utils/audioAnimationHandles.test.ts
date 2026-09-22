import { describe, expect, it } from "vitest";
import {
  parseAutomation,
  serializeAutomation,
  sampleAutomationLane,
} from "@hyperframes/core/audio-automation";
import { splitAudioAutomation } from "./splitAudioAutomation";

describe("audio animation handles", () => {
  it("retains signed key times through serialization, repeated cuts, and extension", () => {
    const original = parseAutomation(
      JSON.stringify({
        version: 1,
        lanes: [
          {
            target: "volume",
            points: [
              { t: -2, v: 0.2, viaX: 0.7, viaY: 0.2 },
              { t: 8, v: 0.9 },
              { t: 15, v: 0.1 },
            ],
          },
          {
            target: "fx.eq.frequency",
            points: [
              { t: 0, v: 100, curve: 0.7 },
              { t: 12, v: 12000 },
            ],
          },
        ],
      }),
    );
    expect(original.lanes[0]!.points[0]!.t).toBe(-2);
    const first = splitAudioAutomation(original, 4);
    const second = splitAudioAutomation(parseAutomation(serializeAutomation(first.right)), 2);
    const right = parseAutomation(serializeAutomation(second.right));
    expect(first.left).toEqual(original);
    for (const [i, lane] of original.lanes.entries()) {
      expect(right.lanes[i]!.points).toEqual(lane.points.map((p) => ({ ...p, t: p.t - 6 })));
      // Extending either edge recovers the same authored curve, with no baking.
      for (let frame = -30; frame < 400; frame++) {
        const time = frame / 30;
        expect(sampleAutomationLane(right.lanes[i]!, time)).toBeCloseTo(
          sampleAutomationLane(lane, time + 6),
          10,
        );
      }
    }
  });
});
