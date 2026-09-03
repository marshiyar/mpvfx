import { describe, expect, it } from "vitest";
import type { TimelineElement } from "../store/playerStore";
import { timelineAttachedEffects } from "./timelineAttachedEffects";

const clip = (over: Partial<TimelineElement> = {}): TimelineElement => ({
  id: "clip",
  label: "Interview",
  tag: "video",
  start: 2,
  duration: 5,
  track: 0,
  ...over,
});

describe("timelineAttachedEffects", () => {
  it("projects color treatment and enabled effects as separate stable strips", () => {
    const effects = timelineAttachedEffects(
      clip({
        colorGrading: '{"preset":"clean-studio"}',
        fxChain: JSON.stringify({
          version: 1,
          nodes: [
            { id: "eq", type: "peaking", enabled: true },
            { id: "off", type: "compressor", enabled: false },
          ],
        }),
      }),
      [
        { id: "blur", effectId: "blur", enabled: true },
        { id: "disabled", effectId: "vignette", enabled: false },
      ],
    );

    expect(effects.map(({ id, label }) => [id, label])).toEqual([
      ["color-grading", "Color"],
      ["audio:eq", "Peaking"],
      ["native:blur", "Blur"],
    ]);
  });

  it("returns no strips for empty or invalid effect state", () => {
    expect(timelineAttachedEffects(clip({ colorGrading: "{}", fxChain: "not-json" }), [])).toEqual(
      [],
    );
  });
});
