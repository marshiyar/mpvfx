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
