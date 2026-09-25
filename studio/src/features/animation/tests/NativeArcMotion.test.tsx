// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeArcMotion } from "../NativeArcMotion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clip = { sequenceId: "sequence:main", trackId: "track:video", clipId: "clip:first" };
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const renderArc = (state: Parameters<typeof NativeArcMotion>[0]["path"]["state"]) => {
  const onChange = vi.fn(async () => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<NativeArcMotion path={{ clip, state }} onChange={onChange} />));
  return onChange;
};

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("NativeArcMotion", () => {
  it("turns arc motion on for every position segment", () => {
    const onChange = renderArc({ frames: [0, 40, 90], segments: [null, null], autoRotate: false, aligned: true });
    const toggle = host!.querySelector('[aria-label="Arc motion"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    act(() => toggle.click());
    expect(onChange).toHaveBeenCalledWith({
      clip,
      segments: [
        { frame: 0, path: { type: "curve", curviness: 1 } },
        { frame: 40, path: { type: "curve", curviness: 1 } },
      ],
    });
  });

  it("turns it off by straightening every segment, keeping nothing curved", () => {
    const onChange = renderArc({
      frames: [0, 40, 90],
      segments: [{ type: "curve", curviness: 1.6 }, null],
      autoRotate: true,
      aligned: true,
    });
    const toggle = host!.querySelector('[aria-label="Arc motion"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    act(() => toggle.click());
    expect(onChange).toHaveBeenCalledWith({ clip, segments: [{ frame: 0, path: null }, { frame: 40, path: null }] });
  });
});
