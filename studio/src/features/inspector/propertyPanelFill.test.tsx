// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GradientField } from "./propertyPanelFill";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("GradientField continuous edits", () => {
  const before = "linear-gradient(90deg, #000000 0%, #777777 50%, #ffffff 100%)";
  it.each(["Escape", "pointercancel", "lostpointercapture", "release"])("previews a held stop and ends with %s", (ending) => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    act(() => root.render(<GradientField value={before} fallbackColor={undefined} onCommit={onCommit} {...{ onPreview }} />));
    const stop = host.querySelector<HTMLElement>('[aria-label="Stop 2 position"]')!;
    let captured = false;
    stop.setPointerCapture = () => { captured = true; };
    stop.releasePointerCapture = () => { captured = false; };
    stop.hasPointerCapture = () => captured;
    stop.parentElement!.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    act(() => stop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 })));
    for (const clientX of [80, 120, -20, 65]) {
      act(() => stop.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX })));
    }
    expect(onCommit).not.toHaveBeenCalled();
    expect(onPreview.mock.calls.at(-1)?.[0]).toContain("65%");
    act(() => {
      if (ending === "Escape") stop.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      else if (ending !== "release") stop.dispatchEvent(new PointerEvent(ending, { bubbles: true, pointerId: 1 }));
      stop.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    });
    if (ending === "release") {
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit.mock.calls[0]?.[0]).toContain("65%");
    } else {
      expect(onCommit).not.toHaveBeenCalled();
      expect(onPreview).toHaveBeenLastCalledWith(before);
    }
    act(() => root.unmount());
  });

  it("does not persist an angle while held, even after the old debounce delay", () => {
    vi.useFakeTimers();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const onCommit = vi.fn();
    act(() => root.render(<GradientField value={before} fallbackColor={undefined} onCommit={onCommit} />));
    const angle = host.querySelector<HTMLInputElement | HTMLDivElement>('[aria-label="Angle"]')!;
    let captured = false;
    angle.setPointerCapture = () => { captured = true; };
    angle.releasePointerCapture = () => { captured = false; };
    angle.hasPointerCapture = () => captured;
    angle.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    act(() => {
      angle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 50, button: 0 }));
      if (angle instanceof HTMLInputElement) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(angle, "225");
        angle.dispatchEvent(new Event("input", { bubbles: true }));
      } else angle.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 62.5 }));
      vi.advanceTimersByTime(600);
    });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => angle.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("rolls back a numeric stop adjustment through the same preview owner", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    act(() => root.render(<GradientField value={before} fallbackColor={undefined} onCommit={onCommit} onPreview={onPreview} />));
    act(() => host.querySelector<HTMLElement>('[aria-label="Stop 2 position"]')!.click());
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Position"]')!;
    act(() => { input.focus(); input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })); });
    expect(onPreview.mock.calls.at(-1)?.[0]).toContain("51%");
    expect(onCommit).not.toHaveBeenCalled();
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
    expect(onPreview).toHaveBeenLastCalledWith(before);
    expect(onCommit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("ends a nested stop-color preview on capture loss without saving the gradient", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    act(() => root.render(<GradientField value={before} fallbackColor={undefined} onCommit={onCommit} onPreview={onPreview} />));
    act(() => host.querySelector<HTMLButtonElement>('[data-flat-color-trigger]')!.click());
    const alpha = document.querySelector<HTMLElement>('[role="slider"][aria-label="Alpha"]')!;
    let captured = false;
    alpha.setPointerCapture = () => { captured = true; };
    alpha.releasePointerCapture = () => { captured = false; };
    alpha.hasPointerCapture = () => captured;
    alpha.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    act(() => alpha.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 25 })));
    expect(onPreview.mock.calls.at(-1)?.[0]).toContain("0.25");
    expect(onCommit).not.toHaveBeenCalled();
    act(() => alpha.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 1 })));
    expect(onPreview).toHaveBeenLastCalledWith(before);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close color picker"]')!.click());
    expect(onCommit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

describe("GradientField stop reset", () => {
  it("edits only the selected stop while retaining every stop on the strip", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<GradientField value="linear-gradient(90deg, #000000 0%, #777777 50%, #ffffff 100%)" fallbackColor={undefined} onCommit={vi.fn()} />));
    expect(host.querySelectorAll('[role="slider"][aria-label^="Stop"]')).toHaveLength(3);
    expect(host.querySelectorAll('[data-gradient-stop-editor]')).toHaveLength(1);
    act(() => host.querySelector<HTMLElement>('[aria-label="Stop 2 position"]')!.click());
    expect(host.querySelector('[data-gradient-stop-editor]')?.textContent).toContain("Stop 2");
    act(() => root.unmount());
  });

  it("adds a usable midpoint stop to a gradient whose endpoints already span 0–100%", () => {
    const host = document.body.appendChild(document.createElement("div")); const root = createRoot(host); const onCommit = vi.fn();
    act(() => root.render(<GradientField value="linear-gradient(90deg, #000000 0%, #ffffff 100%)" fallbackColor={undefined} onCommit={onCommit} />));
    act(() => Array.from(host.querySelectorAll("button")).find(button => button.getAttribute("aria-label") === "Add stop")!.click());
    expect(onCommit.mock.calls[0]?.[0]).toContain("50%");
    act(() => root.unmount());
  });

  it("double-clicking a stop handle restores its evenly spaced default and preserves siblings", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onCommit = vi.fn();

    act(() => {
      root.render(
        <GradientField
          value="linear-gradient(90deg, #000000 10%, #777777 65%, #ffffff 90%)"
          fallbackColor={undefined}
          onCommit={onCommit}
        />,
      );
    });

    const secondStop = host.querySelector<HTMLElement>(
      '[role="slider"][aria-label="Stop 2 position"]',
    );
    expect(secondStop).not.toBeNull();
    act(() => {
      secondStop!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(
      "linear-gradient(90deg, #000000 10%, #777777 50%, #ffffff 90%)",
    );
    act(() => root.unmount());
  });

  it("does not reset a disabled gradient stop", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onCommit = vi.fn();

    act(() => {
      root.render(
        <GradientField
          value="linear-gradient(90deg, #000000 10%, #ffffff 90%)"
          fallbackColor={undefined}
          disabled
          onCommit={onCommit}
        />,
      );
    });

    const firstStop = host.querySelector<HTMLElement>(
      '[role="slider"][aria-label="Stop 1 position"]',
    );
    act(() => {
      firstStop!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onCommit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

it("keeps gradient details collapsed behind a compact preview", () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(<GradientField value="linear-gradient(90deg, #000 0%, #fff 100%)" fallbackColor={undefined} onCommit={vi.fn()} />));
  const editor = host.querySelector<HTMLDetailsElement>('[data-gradient-editor]');
  expect(editor).not.toBeNull();
  expect(editor!.open).toBe(false);
  expect(host.querySelector('[role="slider"][aria-label="Position"]')).not.toBeNull();
  act(() => root.unmount());
});
