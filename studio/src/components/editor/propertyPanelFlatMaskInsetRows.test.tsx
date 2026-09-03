// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlatMaskInsetRows } from "./propertyPanelFlatMaskInsetRows";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

function renderMask(
  clipPathValue: string,
  { radiusValue = 99, disabled = false }: { radiusValue?: number; disabled?: boolean } = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSetStyle = vi.fn();
  act(() => {
    root.render(
      <FlatMaskInsetRows
        clipPathValue={clipPathValue}
        radiusValue={radiusValue}
        disabled={disabled}
        onSetStyle={onSetStyle}
      />,
    );
  });
  return { host, root, onSetStyle };
}

describe("FlatMaskInsetRows resets", () => {
  it("double-clicking the uniform slider knob resets every inset to zero and preserves its radius", () => {
    const { host, root, onSetStyle } = renderMask("inset(8px round 4px)");
    const knob = host.querySelector<HTMLElement>('[data-flat-slider-knob="true"]');
    expect(knob).not.toBeNull();
    act(() => knob?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onSetStyle).toHaveBeenCalledTimes(1);
    expect(onSetStyle).toHaveBeenCalledWith("clip-path", "inset(0px round 4px)");
    act(() => root.unmount());
  });

  it("offers resets only for nonzero inset sides and preserves every other side and radius", () => {
    const { host, root, onSetStyle } = renderMask(
      "inset(5px 0px 7px 9px round 3px)",
    );
    const reset = (side: string) =>
      host.querySelector<HTMLButtonElement>(`[data-flat-mask-side-reset="${side}"]`);
    expect(reset("top")).not.toBeNull();
    expect(reset("right")).toBeNull();
    expect(reset("bottom")).not.toBeNull();
    expect(reset("left")).not.toBeNull();

    act(() => reset("top")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => reset("bottom")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => reset("left")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSetStyle.mock.calls).toEqual([
      ["clip-path", "inset(0px 0px 7px 9px round 3px)"],
      ["clip-path", "inset(5px 0px 0px 9px round 3px)"],
      ["clip-path", "inset(5px 0px 7px 0px round 3px)"],
    ]);
    act(() => root.unmount());
  });

  it("renders no reset action for an all-zero inset", () => {
    const { host, root } = renderMask("inset(0px)");
    expect(host.querySelector('[data-flat-slider-reset="true"]')).toBeNull();
    expect(host.querySelector('[data-flat-mask-side-reset]')).toBeNull();
    act(() => root.unmount());
  });

  it("does not apply either uniform or side resets while mask editing is disabled", () => {
    const { host, root, onSetStyle } = renderMask("inset(8px round 4px)", { disabled: true });
    const uniformReset = host.querySelector<HTMLButtonElement>('[data-flat-slider-reset="true"]');
    const topReset = host.querySelector<HTMLButtonElement>(
      '[data-flat-mask-side-reset="top"]',
    );
    expect(uniformReset?.disabled).toBe(true);
    expect(topReset?.disabled).toBe(true);
    act(() => uniformReset?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => topReset?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSetStyle).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
