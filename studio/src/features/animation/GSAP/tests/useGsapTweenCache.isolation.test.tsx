// @vitest-environment happy-dom
import { createRoot } from "react-dom/client";
import { act } from "react";
import { describe, expect, it } from "vitest";
import { useGsapAnimationsForElement } from "../useGsapTweenCache";

// React's act() diagnostics require this flag in a direct createRoot test.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("GSAP cache across the isolated preview boundary", () => {
  it("keeps the editor mounted when the preview Document is inaccessible", () => {
    const iframe = Object.defineProperty({}, "contentDocument", {
      get: () => { throw new DOMException("cross origin", "SecurityError"); },
    }) as HTMLIFrameElement;
    const iframeRef = { current: iframe };
    const container = document.createElement("div");
    const root = createRoot(container);
    let animations: unknown;
    function Probe() {
      animations = useGsapAnimationsForElement(
        null, "index.html", { id: "clip", selector: "#clip" }, 0, iframeRef,
      ).animations;
      return null;
    }
    act(() => root.render(<Probe />));
    expect(animations).toEqual([]);
    act(() => root.unmount());
  });
});
