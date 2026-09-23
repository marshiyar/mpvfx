// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlatCropControls } from "./propertyPanelFlatCropControls";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

function renderControls(overrides: Partial<Parameters<typeof FlatCropControls>[0]> = {}) {
  const host = document.createElement("div");
  const root = createRoot(host);
  const props: Parameters<typeof FlatCropControls>[0] = {
    active: false,
    links: { all: false, vertical: false, horizontal: false },
    clipPathValue: "inset(10px 20px 30px 40px round 8px)",
    disabled: false,
    onStart: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    onReset: vi.fn(),
    onSetLinks: vi.fn(),
    onSetStyle: vi.fn(),
    ...overrides,
  };
  act(() => root.render(<FlatCropControls {...props} />));
  return { host, root, props };
}

describe("FlatCropControls", () => {
  it("shows no crop measurements or link controls before crop mode starts", () => {
    const { host, root } = renderControls();
    expect(host.querySelector('[aria-label="Start cropping"]')).not.toBeNull();
    expect(host.querySelector("[data-crop-measurements]")).toBeNull();
    expect(host.querySelector("[data-crop-link-all]")).toBeNull();
    act(() => root.unmount());
  });

  it("hides pair links and presents one measurement while all edges are linked", () => {
    const { host, root } = renderControls({
      active: true,
      links: { all: true, vertical: false, horizontal: false },
    });
    expect(host.querySelector("[data-crop-link-all]")).not.toBeNull();
    expect(host.querySelector("[data-crop-link-vertical]")).toBeNull();
    expect(host.querySelector("[data-crop-link-horizontal]")).toBeNull();
    expect(host.querySelectorAll("[data-crop-measurement]")).toHaveLength(1);
    act(() => root.unmount());
  });

  it("shows vertical and horizontal pair links plus four independent measurements when total link is off", () => {
    const { host, root } = renderControls({ active: true });
    expect(host.querySelector("[data-crop-link-vertical]")).not.toBeNull();
    expect(host.querySelector("[data-crop-link-horizontal]")).not.toBeNull();
    expect(host.querySelectorAll("[data-crop-measurement]")).toHaveLength(4);
    act(() => root.unmount());
  });

  it("exposes Apply, Cancel, and Reset throughout active crop mode", () => {
    const { host, root } = renderControls({
      active: true,
      clipPathValue: "none",
    });

    expect(host.querySelector('[aria-label="Apply crop"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Cancel crop"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Reset crop"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Finish cropping"]')).toBeNull();
    act(() => root.unmount());
  });

  it("commits linked measurements as square inset crops with no corner radius", async () => {
    const onSetStyle = vi.fn();
    const { host, root } = renderControls({
      active: true,
      links: { all: false, vertical: true, horizontal: false },
      onSetStyle,
    });
    const topInput = host.querySelector<HTMLInputElement>('[data-crop-measurement="top"] input');
    expect(topInput).not.toBeNull();
    act(() => {
      const setNativeValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setNativeValue?.call(topInput, "16");
      topInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      topInput!.dispatchEvent(new Event("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onSetStyle).toHaveBeenCalledWith(
      "clip-path",
      "inset(16px 20px 16px 40px)",
    );
    act(() => root.unmount());
  });
});
