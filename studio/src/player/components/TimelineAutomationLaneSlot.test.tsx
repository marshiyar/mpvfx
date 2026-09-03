// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { TimelineAutomationLaneSlot } from "./TimelineAutomationLaneSlot";
import { AUTOMATION_LANE_H } from "./automationLaneHeight";
import { getTimelineLaneTop } from "./timelineLayout";
import { elementAutomation, elementAutomationLanes, elementFxChain } from "./automationLaneData";
import type { AutomationLaneBinding, UseAutomationLanesResult } from "./useAutomationLanes";
import type { TimelineElement } from "../store/timelineElement";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const element: TimelineElement = {
  id: "bgm",
  key: "bgm",
  tag: "audio",
  start: 0,
  duration: 6,
  track: 0,
};

function mountSlot(binding: Partial<AutomationLaneBinding>) {
  const onRangeClear = vi.fn();
  const lanes: UseAutomationLanesResult = {
    bind: () => ({
      automation: { version: 1, lanes: [] },
      lanes: [{ target: "volume", points: [{ t: 0, v: 1 }] }],
      chain: null,
      onPreview: vi.fn(),
      onCommit: vi.fn(),
      onSelect: vi.fn(),
      readOnly: false,
      commitTargetKey: "bgm",
      selection: null,
      onRangeSelect: vi.fn(),
      onRangeClear,
      ...binding,
    }),
  };
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      <TimelineAutomationLaneSlot
        elements={[element]}
        isSelected={() => false}
        lanes={lanes}
        pps={100}
        laneCount={0}
        accentColor="#0af"
        currentTime={0}
      />,
    );
  });
  return { onRangeClear };
}

/** Two narration slices sharing a row, each with its own chain. */
const chainOf = (nodes: unknown[]) => JSON.stringify({ version: 1, nodes });
const lanesOf = (...targets: string[]) =>
  JSON.stringify({
    version: 1,
    lanes: targets.map((target) => ({ target, points: [{ t: 0, v: 1 }] })),
  });

const narration1: TimelineElement = {
  ...element,
  id: "narration-1",
  key: "narration-1",
  start: 0,
  duration: 4,
  fxChain: chainOf([
    { type: "lowpass", id: "n1", params: { frequency: 8000, q: 0.7, poles: "2" } },
    { type: "peaking", id: "n2", params: { frequency: 1000, gain: -3, q: 1.4 } },
  ]),
  automation: lanesOf("fx.n2.q"),
};
const narration2: TimelineElement = {
  ...element,
  id: "narration-2",
  key: "narration-2",
  start: 4,
  duration: 4,
  fxChain: chainOf([{ type: "peaking", id: "n1", params: { frequency: 1000, gain: -6, q: 1.4 } }]),
  automation: lanesOf("fx.n1.q", "volume"),
};

/** Reads what a clip really carries, the way the live binding does. */
const readingBind = (element: TimelineElement, isSelected: boolean): AutomationLaneBinding => ({
  automation: elementAutomation(element),
  lanes: elementAutomationLanes(element),
  chain: elementFxChain(element),
  onPreview: vi.fn(),
  onCommit: vi.fn(),
  onSelect: vi.fn(),
  readOnly: !isSelected,
  commitTargetKey: null,
  selection: null,
  onRangeSelect: vi.fn(),
  onRangeClear: vi.fn(),
});

function renderRow(elements: readonly TimelineElement[], selectedKey?: string): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      <TimelineAutomationLaneSlot
        elements={elements}
        isSelected={(el) => el.key === selectedKey}
        lanes={{ bind: readingBind }}
        pps={100}
        laneCount={0}
        accentColor="#0af"
        currentTime={0}
      />,
    );
  });
  return host;
}

/** Every editable envelope as `row @ clip-left`. */
function mountRow(elements: readonly TimelineElement[], selectedKey?: string) {
  return [...renderRow(elements, selectedKey).querySelectorAll<HTMLElement>(".hf-automation-lane")]
    .map((lane) => `${lane.style.top} @ ${lane.querySelector<HTMLElement>(".hf-automation-svg")?.style.left}`)
    .sort();
}

const ROW_0 = `${getTimelineLaneTop(0)}px`;
const ROW_1 = `${getTimelineLaneTop(0) + AUTOMATION_LANE_H}px`;

describe("TimelineAutomationLaneSlot shared rows", () => {
  it("draws two clips' envelopes for one property in the same row", () => {
    // One lane track, two envelopes — same row, each over its own span. The
    // 1 kHz peaking Q is `fx.n2.q` on one clip and `fx.n1.q` on the other.
    expect(mountRow([narration1, narration2])).toEqual(
      [
        `${ROW_0} @ -9px`,
        `${ROW_0} @ 391px`,
        `${ROW_1} @ 391px`,
      ].sort(),
    );
  });

  it("leaves a clip's stretch empty in a row it does not automate", () => {
    // Only narration-2 has a volume envelope, so row 1 carries one curve and
    // narration-1's half of it stays blank rather than drawing a flat line.
    expect(mountRow([narration1, narration2]).filter((row) => row.startsWith(ROW_1))).toEqual([
      `${ROW_1} @ 391px`,
    ]);
  });

  it("uses full editable envelope lanes rather than effect strips", () => {
    const host = renderRow([narration1, narration2]);
    const bands = [...host.querySelectorAll<HTMLElement>(".hf-automation-lane")];
    expect(bands.length).toBeGreaterThan(1);
    for (const band of bands) {
      expect(band.style.height).toBe(`${AUTOMATION_LANE_H}px`);
      expect(band.querySelector(".hf-automation-svg")).not.toBeNull();
    }
    expect(host.querySelector(".hf-automation-strip")).toBeNull();
  });

  it("keeps the same rows whichever clip is selected", () => {
    // The bug this replaces: the row listed only the selected clip's lanes, so
    // clicking a sibling swapped which envelopes existed.
    expect(mountRow([narration1, narration2], "narration-1")).toEqual(
      mountRow([narration1, narration2], "narration-2"),
    );
  });
});

describe("TimelineAutomationLaneSlot stale-selection guard", () => {
  it("clears the selection when its lane's target no longer exists", () => {
    const { onRangeClear } = mountSlot({
      selection: { elementKey: "bgm", target: "fx.gone.wet", t0: 1, t1: 2, v0: 0, v1: 1 },
    });
    expect(onRangeClear).toHaveBeenCalledTimes(1);
  });

  it("leaves an in-scope selection alone", () => {
    const { onRangeClear } = mountSlot({
      selection: { elementKey: "bgm", target: "volume", t0: 1, t1: 2, v0: 0, v1: 1 },
    });
    expect(onRangeClear).not.toHaveBeenCalled();
  });
});
