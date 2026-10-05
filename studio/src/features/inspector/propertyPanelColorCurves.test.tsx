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

function typeNumber(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("Expected native input setter");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ColorCurves", () => {
  it.each(["Enter", " ", "Delete", "Backspace", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"])("keeps its handled %s key from bubbling into unrelated commands", (key) => {
    const { host, root } = renderCurves();
    const graph = activate(host, "master");
    const onGlobalKey = vi.fn();
    window.addEventListener("keydown", onGlobalKey);
    try {
      act(() => graph.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
      expect(onGlobalKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onGlobalKey);
      act(() => root.unmount());
    }
  });
  it("keeps curve cancellation scoped while leaving other keys and outside Escape global", () => {
    const { host, root, onPreview, onCommit } = renderCurves();
    const graph = activate(host, "master");
    const onGlobalKey = vi.fn();
    window.addEventListener("keydown", onGlobalKey);
    try {
      act(() => graph.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, pointerId: 7, clientX: 80, clientY: 50,
      })));
      act(() => graph.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true, cancelable: true, key: "Escape",
      })));
      expect(onPreview).toHaveBeenLastCalledWith(IDENTITY);
      expect(onGlobalKey).not.toHaveBeenCalled();
      act(() => graph.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, pointerId: 7, clientX: 80, clientY: 50,
      })));
      expect(onCommit).not.toHaveBeenCalled();
      act(() => graph.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "q" })));
      act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
      expect(onGlobalKey.mock.calls.map(([event]) => event.key)).toEqual(["q", "Escape"]);
    } finally {
      window.removeEventListener("keydown", onGlobalKey);
      act(() => root.unmount());
    }
  });

  it("renders the four RGB and three hue-selective curve tabs", () => {
    const { host, root } = renderCurves();
    expect(host.querySelectorAll("[data-color-curve-tab]")).toHaveLength(7);
    expect(host.querySelector('[data-color-curve-graph="master"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("selects points across the red seam without moving them or adding a duplicate", () => {
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

    expect(onCommit).not.toHaveBeenCalled();
    expect(host.querySelectorAll('[data-color-curve-point]')).toHaveLength(3);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Curve point hue"]')?.value).toBe("359");
    act(() => root.unmount());
  });

  it("selects a close-input RGB node even when the click is far above its output", () => {
    const value: ColorCurveValues = {
      ...IDENTITY,
      curves: { ...IDENTITY.curves, master: [[0, 0], [0.39, 0.25], [1, 1]] },
    };
    const { host, root, onPreview, onCommit } = renderCurves(value);
    const graph = activate(host, "master");
    act(() => {
      graph.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, pointerId: 14, clientX: 66, clientY: 12,
      }));
      graph.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, pointerId: 14, clientX: 66, clientY: 12,
      }));
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(value);
    expect(onCommit).not.toHaveBeenCalled();
    expect(host.querySelectorAll('[data-color-curve-point]')).toHaveLength(3);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Curve point input"]')?.value).toBe("0.39");
    act(() => root.unmount());
  });

  it("keeps the grab offset when dragging a node picked by its input", () => {
    const value: ColorCurveValues = {
      ...IDENTITY,
      curves: { ...IDENTITY.curves, master: [[0, 0], [0.39, 0.25], [1, 1]] },
    };
    const { host, root, onCommit } = renderCurves(value);
    const graph = activate(host, "master");
    act(() => {
      graph.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, pointerId: 17, clientX: 66, clientY: 12,
      }));
      graph.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 17, clientX: 70, clientY: 16,
      }));
      graph.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, pointerId: 17, clientX: 70, clientY: 16,
      }));
    });
    const moved = onCommit.mock.calls.at(-1)?.[0]?.curves.master[1];
    expect(moved[0]).toBeCloseTo(0.39 + 4 / 144, 4);
    expect(moved[1]).toBeCloseTo(0.25 - 4 / 144, 4);
    act(() => root.unmount());
  });

  it("shows the constrained coordinate and then the selected close sibling", () => {
    const value: ColorCurveValues = {
      ...IDENTITY,
      curves: { ...IDENTITY.curves, master: [[0, 0], [0.4, 0.25], [0.41, 0.75], [1, 1]] },
    };
    const { host, root, onCommit } = renderCurves(value);
    const graph = activate(host, "master");
    act(() => {
      graph.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, pointerId: 18, clientX: 65.6, clientY: 116,
      }));
      graph.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, pointerId: 18, clientX: 65.6, clientY: 116,
      }));
    });
    const input = host.querySelector<HTMLInputElement>('[aria-label="Curve point input"]');
    if (!input) throw new Error("Expected selected curve input");
    act(() => input.focus());
    act(() => typeNumber(input, "0.99"));
    act(() => input.blur());
    expect(input.value).toBe("0.368");
    expect(onCommit.mock.calls.at(-1)?.[0]?.curves.master).toEqual([
      [0, 0], [0.3683333333333333, 0.25], [0.41, 0.75], [1, 1],
    ]);
    act(() => graph.dispatchEvent(new KeyboardEvent("keydown", {
      key: "PageDown", bubbles: true, cancelable: true,
    })));
    expect(input.value).toBe("0.41");
    act(() => root.unmount());
  });

  it("keeps RGB nodes pickable and ordered through rapid crossing drags", () => {
    const value: ColorCurveValues = {
      ...IDENTITY,
      curves: { ...IDENTITY.curves, master: [[0, 0], [0.25, 0.8], [0.5, 0.2], [1, 1]] },
    };
    const { host, root, onCommit } = renderCurves(value);
    const graph = activate(host, "master");
    act(() => {
      graph.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, pointerId: 15, clientX: 44, clientY: 37,
      }));
      graph.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 15, clientX: 100, clientY: 20,
      }));
      graph.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 15, clientX: 68, clientY: 30,
      }));
      graph.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, pointerId: 15, clientX: 100, clientY: 20,
      }));
    });
    const points = onCommit.mock.calls.at(-1)?.[0]?.curves.master;
    expect(points).toHaveLength(4);
    expect(points[1][0]).toBeGreaterThanOrEqual(0.5 - 1 / 24);
    expect(points[1][0]).toBeLessThan(points[2][0]);
    expect(points.every(([x, y]: readonly [number, number]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    act(() => root.unmount());
  });

  it("preserves circular hue order while dragging through the seam", () => {
    const value: ColorCurveValues = {
      ...IDENTITY,
      hueCurves: { ...IDENTITY.hueCurves, hueVsHue: [[20, 0], [140, 60], [260, -60]] },
    };
    const { host, root, onCommit } = renderCurves(value);
    const graph = activate(host, "hueVsHue");
    act(() => {
      graph.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, pointerId: 16, clientX: 16, clientY: 80,
      }));
      graph.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 16, clientX: 151, clientY: 80,
      }));
      graph.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, pointerId: 16, clientX: 151, clientY: 80,
      }));
    });
    const points = onCommit.mock.calls.at(-1)?.[0]?.hueCurves.hueVsHue;
    expect(points).toHaveLength(3);
    expect(points[2][0]).toBeGreaterThan(340);
    expect(points[2][0]).toBeLessThan(360);
    expect(points[0][0]).toBe(140);
    expect(points[1][0]).toBe(260);
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
    expect(onPreview.mock.calls[0]?.[0]?.curves.master).toHaveLength(2);
    expect(onPreview.mock.calls.at(-1)?.[0]?.curves.master).toHaveLength(3);
    expect(onPreview.mock.calls.at(-1)?.[0]).toEqual(onCommit.mock.calls[0]?.[0]);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(host.querySelectorAll('[data-color-curve-point]')).toHaveLength(3);
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
