// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transform3DCube } from "./Transform3DCube";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Transform3DCube reset gesture", () => {
  it("double-clicking its slider surface resets exactly once without a pose commit", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onRecenter = vi.fn();
    const onPoseCommit = vi.fn();
    act(() => {
      root.render(
        <Transform3DCube
          pose={{ rotationX: 12, rotationY: -8, rotationZ: 4 }}
          onPoseCommit={onPoseCommit}
          onRecenter={onRecenter}
        />,
      );
    });

    const surface = host.querySelector<SVGSVGElement>('[role="slider"]');
    const event = new MouseEvent("dblclick", { bubbles: true, cancelable: true });
    act(() => surface?.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(onRecenter).toHaveBeenCalledTimes(1);
    expect(onPoseCommit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("does not claim double-click when no reset callback is available", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onPoseCommit = vi.fn();
    act(() => {
      root.render(
        <Transform3DCube
          pose={{ rotationX: 12, rotationY: -8, rotationZ: 4 }}
          onPoseCommit={onPoseCommit}
        />,
      );
    });

    const surface = host.querySelector<SVGSVGElement>('[role="slider"]');
    const event = new MouseEvent("dblclick", { bubbles: true, cancelable: true });
    act(() => surface?.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    expect(onPoseCommit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
