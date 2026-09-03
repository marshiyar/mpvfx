// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ColorCurveValues } from "./propertyPanelColorCurves";
import { ColorCurves } from "./propertyPanelColorCurves";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IDENTITY: ColorCurveValues = {
  curves: {
    master: [
      [0, 0],
      [1, 1],
    ],
    red: [
      [0, 0],
      [1, 1],
    ],
    green: [
      [0, 0],
      [1, 1],
    ],
    blue: [
      [0, 0],
      [1, 1],
    ],
  },
  hueCurves: { hueVsHue: [], hueVsSaturation: [], hueVsLuma: [] },
};

afterEach(() => {
  document.body.innerHTML = "";
});

function renderCurves(value = IDENTITY) {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const rerender = (nextValue: ColorCurveValues) => {
    act(() =>
      root.render(
        <ColorCurves value={nextValue} onPreview={onPreview} onCommit={onCommit} />,
      ),
    );
  };
  rerender(value);
  return { host, root, onPreview, onCommit, rerender };
}

function activate(host: HTMLElement, key: string) {
  act(() => {
    host
      .querySelector<HTMLButtonElement>(`[data-color-curve-tab="${key}"]`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const graph = host.querySelector<SVGSVGElement>(`[data-color-curve-graph="${key}"]`);
  if (!graph) throw new Error(`Expected ${key} graph`);
  Object.defineProperty(graph, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, width: 160, height: 160, right: 160, bottom: 160 }),
  });
  return graph;
}

describe("ColorCurves", () => {
  it("renders the four RGB and three hue-selective curve tabs", () => {
    const { host, root } = renderCurves();
    expect(host.querySelectorAll("[data-color-curve-tab]")).toHaveLength(7);
    expect(host.querySelector('[data-color-curve-graph="master"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("treats points across the red seam as neighbors instead of adding a duplicate", () => {
    const value: ColorCurveValues = {
      ...IDENTITY,
      hueCurves: {
        ...IDENTITY.hueCurves,
        hueVsSaturation: [
          [120, 0],
          [240, 0],
          [359, 0.2],
        ],
      },
    };
    const { host, root, onCommit } = renderCurves(value);
    const graph = activate(host, "hueVsSaturation");

    act(() => {
      graph.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 5,
          clientX: 8,
          clientY: 66,
        }),
      );
      graph.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 5,
          clientX: 8,
          clientY: 66,
        }),
      );
    });

    const points = onCommit.mock.calls[0]?.[0]?.hueCurves.hueVsSaturation;
    expect(points).toHaveLength(3);
    expect(points.some(([hue]: readonly [number, number]) => hue < 1)).toBe(true);
    act(() => root.unmount());
  });

  it("previews pointer edits and commits once on release", () => {
    const { host, root, onPreview, onCommit } = renderCurves();
    const graph = activate(host, "master");
    act(() => {
      graph.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 2,
          clientX: 80,
          clientY: 120,
        }),
      );
      graph.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 2,
          clientX: 80,
          clientY: 120,
        }),
      );
    });
    expect(onPreview.mock.calls[0]?.[0]?.curves.master).toHaveLength(3);
    expect(onPreview.mock.calls.at(-1)?.[0]).toBe(IDENTITY);
    expect(onCommit).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("keeps one pointer coordinate frame when the panel layout shifts during a drag", () => {
    const { host, root, onPreview } = renderCurves();
    const graph = activate(host, "master");
    let graphLeft = 0;
    Object.defineProperty(graph, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: graphLeft,
        top: 0,
        width: 160,
        height: 160,
        right: graphLeft + 160,
        bottom: 160,
      }),
    });

    act(() => {
      graph.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 8,
          clientX: 80,
          clientY: 80,
        }),
      );
    });

    graphLeft = 20;
    act(() => {
      graph.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 8,
          clientX: 100,
          clientY: 80,
        }),
      );
    });
    const firstMove = onPreview.mock.calls.at(-1)?.[0]?.curves.master[1];

    graphLeft = 40;
    act(() => {
      graph.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 8,
          clientX: 100,
          clientY: 80,
        }),
      );
    });
    const secondMove = onPreview.mock.calls.at(-1)?.[0]?.curves.master[1];

    expect(firstMove).toBeDefined();
    expect(secondMove).toBeDefined();
    expect(secondMove?.[0]).toBeCloseTo(firstMove?.[0] ?? Number.NaN, 6);
    expect(secondMove?.[1]).toBeCloseTo(firstMove?.[1] ?? Number.NaN, 6);

    act(() => root.unmount());
  });

  it("keeps the active draft when a playback render supplies an equivalent value wrapper", () => {
    const { host, root, rerender } = renderCurves();
    const graph = activate(host, "master");

    act(() => {
      graph.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 9,
          clientX: 80,
          clientY: 100,
        }),
      );
    });
    expect(host.querySelectorAll("[data-color-curve-point]")).toHaveLength(3);

    rerender({ curves: IDENTITY.curves, hueCurves: IDENTITY.hueCurves });

    expect(host.querySelectorAll("[data-color-curve-point]")).toHaveLength(3);
    act(() => root.unmount());
  });

  it("does not recommit a stale pointer draft after an external curve replacement", () => {
    const { host, root, onCommit, rerender } = renderCurves();
    const graph = activate(host, "master");

    act(() => {
      graph.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 11,
          clientX: 80,
          clientY: 100,
        }),
      );
    });

    const externalValue: ColorCurveValues = {
      curves: {
        ...IDENTITY.curves,
        master: [
          [0, 0],
          [0.25, 0.8],
          [1, 1],
        ],
      },
      hueCurves: IDENTITY.hueCurves,
    };
    rerender(externalValue);
    const currentGraph = host.querySelector<SVGSVGElement>('[data-color-curve-graph="master"]');
    if (!currentGraph) throw new Error("Expected replacement master graph");

    act(() => {
      currentGraph.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 11,
          clientX: 100,
          clientY: 80,
        }),
      );
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(
      host.querySelector<SVGCircleElement>('[data-color-curve-point="1"]')?.getAttribute("cx"),
    ).toBe("44");
    act(() => root.unmount());
  });

  it("keeps the graph mounted and focused when a commit is acknowledged with cloned curves", () => {
    const { host, root, onCommit, rerender } = renderCurves();
    const graph = activate(host, "master");

    act(() => {
      graph.focus();
      graph.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 12,
          clientX: 80,
          clientY: 100,
        }),
      );
      graph.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 12,
          clientX: 80,
          clientY: 100,
        }),
      );
    });
    const committed = onCommit.mock.calls.at(-1)?.[0] as ColorCurveValues | undefined;
    if (!committed) throw new Error("Expected committed curve value");
    const graphBeforeAck = host.querySelector<SVGSVGElement>(
      '[data-color-curve-graph="master"]',
    );
    if (!graphBeforeAck) throw new Error("Expected graph before acknowledgement");
    act(() => graphBeforeAck.focus());

    const clonedAck = JSON.parse(JSON.stringify(committed)) as ColorCurveValues;
    rerender(clonedAck);

    expect(host.querySelector('[data-color-curve-graph="master"]')).toBe(graphBeforeAck);
    expect(document.activeElement).toBe(graphBeforeAck);
    act(() => root.unmount());
  });

  it("keeps the dragged point node mounted while its coordinates change", () => {
    const { host, root } = renderCurves();
    const graph = activate(host, "master");

    act(() => {
      graph.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 10,
          clientX: 80,
          clientY: 100,
        }),
      );
    });
    const draggedPoint = host.querySelector('[data-color-curve-point="1"]');

    act(() => {
      graph.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 10,
          clientX: 100,
          clientY: 80,
        }),
      );
    });

    expect(host.querySelector('[data-color-curve-point="1"]')).toBe(draggedPoint);
    act(() => root.unmount());
  });

  it("does not restore a deleted point when an overlapping key gesture settles", () => {
    const { host, root, onCommit } = renderCurves();
    const graph = activate(host, "master");
    act(() => {
      graph.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCommit.mock.calls.at(-1)?.[0]?.curves.master).toHaveLength(3);
    onCommit.mockClear();

    act(() => {
      graph.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    act(() => {
      graph.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    act(() => {
      graph.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true }));
    });

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit.mock.calls[0]?.[0]?.curves.master).toHaveLength(2);
    act(() => root.unmount());
  });
});
