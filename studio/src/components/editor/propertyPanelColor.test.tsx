// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDesignInputThrottle } from "../../utils/designInputTracking";
import { ColorField } from "./propertyPanelColor";

const trackStudioEvent = vi.hoisted(() => vi.fn());

vi.mock("../../utils/studioTelemetry", () => ({
  trackStudioEvent: (...args: unknown[]) => trackStudioEvent(...args),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

beforeEach(() => {
  trackStudioEvent.mockReset();
  __resetDesignInputThrottle();
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.innerHTML = "";
});

function renderColorField({
  value = "#333333",
  disabled,
  onPreview,
  onCommit = vi.fn(),
  onReset,
}: {
  value?: string;
  disabled?: boolean;
  onPreview?: (value: string) => void;
  onCommit?: (value: string) => void;
  onReset?: () => void;
} = {}): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      <ColorField
        flat
        label="Color"
        value={value}
        disabled={disabled}
        onPreview={onPreview}
        onCommit={onCommit}
        onReset={onReset}
      />,
    );
  });
  return host;
}

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("expected native input value setter");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function openHexInput(host: HTMLElement): HTMLInputElement {
  const trigger = host.querySelector<HTMLButtonElement>('[data-flat-color-trigger="true"]');
  if (!trigger) throw new Error("Color trigger was not rendered");
  act(() => trigger.click());
  const input = document.querySelector<HTMLInputElement>('input[spellcheck="false"]');
  if (!input) throw new Error("Hex input was not rendered");
  return input;
}

function openColorSlider(host: HTMLElement, label: "Hue" | "Alpha"): HTMLElement {
  const trigger = host.querySelector<HTMLButtonElement>('[data-flat-color-trigger="true"]');
  if (!trigger) throw new Error("Color trigger was not rendered");
  act(() => trigger.click());
  const slider = document.querySelector<HTMLElement>(`[role="slider"][aria-label="${label}"]`);
  if (!slider) throw new Error(`${label} slider was not rendered`);
  return slider;
}

function clickOutside(): void {
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
}

describe("ColorField flat trigger", () => {
  it("renders label and value inline with a small swatch, no boxed border", () => {
    const host = renderColorField({ value: "rgb(255, 176, 32)" });
    const trigger = host.querySelector<HTMLButtonElement>('[data-flat-color-trigger="true"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.className).not.toContain("border-neutral-800");
    expect(host.textContent).toContain("Color");
  });

  it("persists one keyboard slider gesture on keyup", () => {
    const onCommit = vi.fn();
    renderColorField({ value: "rgb(255, 176, 32)", onCommit });
    const trigger = document.querySelector<HTMLButtonElement>('[data-flat-color-trigger="true"]');
    if (!trigger) throw new Error("Color trigger was not rendered");
    act(() => {
      trigger.click();
    });
    const hue = document.querySelector<HTMLElement>('[role="slider"][aria-label="Hue"]');
    if (!hue) throw new Error("Hue slider was not rendered");

    act(() => {
      hue.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => {
      hue.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowRight" }));
    });

    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("offers an explicit flat reset when the caller supplies one", () => {
    const onReset = vi.fn();
    const host = renderColorField({ onReset });
    const reset = host.querySelector<HTMLButtonElement>('[aria-label="Reset Color"]');
    expect(reset).not.toBeNull();
    act(() => reset?.click());
    expect(onReset).toHaveBeenCalledOnce();
  });

  it.each(["Hue", "Alpha"] as const)(
    "double-clicking the custom %s slider resets exactly once without committing a color edit",
    (sliderLabel) => {
      const onReset = vi.fn();
      const onCommit = vi.fn();
      const host = renderColorField({ value: "rgba(51, 102, 153, 0.6)", onReset, onCommit });
      const slider = openColorSlider(host, sliderLabel);
      const event = new MouseEvent("dblclick", { bubbles: true, cancelable: true });

      act(() => slider.dispatchEvent(event));

      expect(event.defaultPrevented).toBe(true);
      expect(onReset).toHaveBeenCalledTimes(1);
      expect(onCommit).not.toHaveBeenCalled();
      expect(trackStudioEvent).toHaveBeenCalledTimes(1);
      expect(trackStudioEvent).toHaveBeenLastCalledWith("design_input", {
        ui: "classic",
        section: "unknown",
        control: "button",
        name: "reset-color",
      });
    },
  );

  it.each(["Hue", "Alpha"] as const)(
    "leaves the default %s slider inert on double-click when no reset callback exists",
    (sliderLabel) => {
      const onCommit = vi.fn();
      const slider = openColorSlider(renderColorField({ onCommit }), sliderLabel);

      act(() => slider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

      expect(onCommit).not.toHaveBeenCalled();
      expect(trackStudioEvent).not.toHaveBeenCalled();
    },
  );

  it("does not reset from either color slider after the field becomes disabled", () => {
    const onReset = vi.fn();
    const onCommit = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    function Harness() {
      const [disabled, setDisabled] = React.useState(false);
      return (
        <>
          <button type="button" data-disable-color onClick={() => setDisabled(true)}>
            Disable
          </button>
          <ColorField
            flat
            label="Color"
            value="rgba(51, 102, 153, 0.6)"
            disabled={disabled}
            onReset={onReset}
            onCommit={onCommit}
          />
        </>
      );
    }
    act(() => root.render(<Harness />));
    const hue = openColorSlider(host, "Hue");
    const alpha = document.querySelector<HTMLElement>('[role="slider"][aria-label="Alpha"]');
    if (!alpha) throw new Error("Alpha slider was not rendered");
    act(() => host.querySelector<HTMLButtonElement>("[data-disable-color]")?.click());

    act(() => {
      hue.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      alpha.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    expect(hue.getAttribute("aria-disabled")).toBe("true");
    expect(alpha.getAttribute("aria-disabled")).toBe("true");
    expect(onReset).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(trackStudioEvent).not.toHaveBeenCalled();
  });
});

describe("ColorField hex editing", () => {
  it("allows #333333 to be backspaced to #3 without snapping", () => {
    const input = openHexInput(renderColorField());

    for (const value of ["#33333", "#3333", "#333", "#33", "#3"]) {
      act(() => changeInput(input, value));
      expect(input.value).toBe(value);
    }
  });

  it("does not silently change #22CC66 to #2222CC while backspacing", () => {
    const input = openHexInput(renderColorField({ value: "#22CC66" }));

    for (const value of ["#22CC6", "#22CC", "#22C"]) {
      act(() => changeInput(input, value));
      expect(input.value).toBe(value);
      expect(input.value).not.toBe("#2222CC");
    }
  });

  it("commits a full replacement after selecting the existing value", () => {
    const onCommit = vi.fn();
    const input = openHexInput(renderColorField({ onCommit }));
    input.focus();
    input.select();

    act(() => changeInput(input, "#12AB34"));
    act(() => input.blur());

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith("rgb(18, 171, 52)");
  });

  it("commits a complete pending hex on outside-click", () => {
    const onCommit = vi.fn();
    const input = openHexInput(renderColorField({ onCommit }));

    act(() => changeInput(input, "#12AB34"));
    act(clickOutside);

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith("rgb(18, 171, 52)");
  });

  it("commits a 3-digit hex shorthand on outside-click", () => {
    // parseCssColor accepts shorthand, so the gesture resolver has to as well;
    // #F00 is ordinary designer input and used to be dropped in silence.
    const onCommit = vi.fn();
    const input = openHexInput(renderColorField({ onCommit }));

    act(() => changeInput(input, "#F00"));
    act(clickOutside);

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith("rgb(255, 0, 0)");
  });

  it("does not commit an incomplete pending hex on outside-click", () => {
    const onCommit = vi.fn();
    const host = renderColorField({ value: "#224466", onCommit });
    const input = openHexInput(host);

    act(() => changeInput(input, "#12AB3"));
    act(clickOutside);

    expect(onCommit).not.toHaveBeenCalled();
    // The settle also has to put the field back, or the panel re-opens showing
    // a value the composition never took.
    expect(openHexInput(host).value).toBe("#224466");
  });

  it("cancels a pending hex edit on Escape and restores the previous value", () => {
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const host = renderColorField({ value: "#224466", onPreview, onCommit });
    const input = openHexInput(host);

    act(() => changeInput(input, "#12AB34"));
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

    expect(onCommit).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenLastCalledWith("rgb(34, 68, 102)");
    expect(openHexInput(host).value).toBe("#224466");
  });

  it("still commits a complete hex on Tab-blur", () => {
    const onCommit = vi.fn();
    const input = openHexInput(renderColorField({ onCommit }));
    input.focus();

    act(() => changeInput(input, "#12AB34"));
    act(() => input.blur());

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith("rgb(18, 171, 52)");
  });

  it("live-previews only a hex length that parses, 3 or 6 digits", () => {
    const onPreview = vi.fn();
    const input = openHexInput(renderColorField({ value: "#112233", onPreview }));

    // 4 and 5 digits are mid-typing, so they must stay silent.
    act(() => changeInput(input, "#3333"));
    act(() => changeInput(input, "#33333"));
    expect(onPreview).not.toHaveBeenCalled();

    act(() => changeInput(input, "#333333"));
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith("rgb(51, 51, 51)");

    act(() => changeInput(input, "#333"));
    expect(onPreview).toHaveBeenCalledTimes(2);
    expect(onPreview).toHaveBeenLastCalledWith("rgb(51, 51, 51)");
  });

  it("tracks exactly once per completed edit, not once per keystroke", () => {
    const input = openHexInput(renderColorField());

    for (const value of ["#", "#1", "#12", "#12A", "#12AB", "#12AB3", "#12AB34"]) {
      act(() => changeInput(input, value));
    }
    act(clickOutside);

    expect(trackStudioEvent).toHaveBeenCalledOnce();
  });
});
