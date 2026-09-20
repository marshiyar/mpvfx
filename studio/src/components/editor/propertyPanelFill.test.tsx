// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GradientField } from "./propertyPanelFill";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
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
