// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColorGradingSliderControl } from "./propertyPanelColorGradingSlider";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("ColorGradingSliderControl reset gesture", () => {
  it("double-clicks the native slider to invoke reset exactly once without a normal commit", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const onCommit = vi.fn();
    const onReset = vi.fn();
    act(() =>
      root.render(
        <ColorGradingSliderControl
          label="Exposure"
          value={25}
          min={-100}
          max={100}
          step={1}
          displayValue="25"
          onCommit={onCommit}
          onReset={onReset}
        />,
      ),
    );
    const range = host.querySelector<HTMLInputElement>('input[type="range"]');
    act(() => range?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("ignores double-click when disabled or when reset is unavailable", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const onReset = vi.fn();
    act(() =>
      root.render(
        <ColorGradingSliderControl
          label="Exposure"
          value={25}
          min={-100}
          max={100}
          step={1}
          displayValue="25"
          disabled
          onCommit={vi.fn()}
          onReset={onReset}
        />,
      ),
    );
    act(() =>
      host
        .querySelector<HTMLInputElement>('input[type="range"]')
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    expect(onReset).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

describe("ColorGradingSliderControl pending commit durability", () => {
  it("commits the final debounced value exactly once when unmounted before the timer fires", () => {
    vi.useFakeTimers();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const onCommit = vi.fn();
    act(() =>
      root.render(
        <ColorGradingSliderControl
          label="Exposure"
          value={0}
          min={-100}
          max={100}
          step={1}
          displayValue="0"
          onCommit={onCommit}
        />,
      ),
    );
    const range = host.querySelector<HTMLInputElement>('input[type="range"]');
    if (!range) throw new Error("expected color-grading slider");
    const setRangeValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setRangeValue) throw new Error("expected native input value setter");

    act(() => {
      setRangeValue.call(range, "35");
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onCommit).not.toHaveBeenCalled();

    act(() => root.unmount());

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(35);

    act(() => vi.advanceTimersByTime(40));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
