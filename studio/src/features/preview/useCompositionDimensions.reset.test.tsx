// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { useCompositionDimensions } from "./useCompositionDimensions";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("composition dimension ownership", () => {
  it("clears the previous scene's dimensions when the active composition changes", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const Harness = ({ composition }: { composition: string }) => {
      const dimensions = useCompositionDimensions(composition);
      return <output>{dimensions ? `${dimensions.width}x${dimensions.height}` : "unknown"}</output>;
    };

    act(() => root.render(<Harness composition="index.html" />));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "hf-preview", type: "stage-size", width: 1920, height: 1080 },
        }),
      );
    });
    expect(host.textContent).toBe("1920x1080");

    act(() => root.render(<Harness composition="compositions/portrait.html" />));
    expect(host.textContent).toBe("unknown");
    act(() => root.unmount());
  });

  it("accepts stage sizes only from the main preview iframe", () => {
    const host = document.createElement("div");
    const preview = document.createElement("iframe");
    const secondary = document.createElement("iframe");
    document.body.append(preview, secondary);
    Object.defineProperty(preview, "src", { configurable: true, value: "mpvfx://616263.preview/api/projects/abc/preview" });
    Object.defineProperty(secondary, "src", { configurable: true, value: "mpvfx://646566.preview/api/projects/def/preview" });
    const root = createRoot(host);
    const Harness = () => {
      const dimensions = useCompositionDimensions("index.html", { current: preview });
      return <output>{dimensions ? `${dimensions.width}x${dimensions.height}` : "unknown"}</output>;
    };
    const sendSize = (source: Window | null, width: number, height: number) => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source,
          origin: source === preview.contentWindow ? "mpvfx://616263.preview" : "mpvfx://646566.preview",
          data: { source: "hf-preview", type: "stage-size", width, height },
        }),
      );
    };

    act(() => root.render(<Harness />));
    act(() => sendSize(secondary.contentWindow, 1080, 1920));
    expect(host.textContent).toBe("unknown");
    act(() => window.dispatchEvent(new MessageEvent("message", {
      source: preview.contentWindow,
      origin: "mpvfx://editor",
      data: { source: "hf-preview", type: "stage-size", width: 4000, height: 2000 },
    })));
    expect(host.textContent).toBe("unknown");
    act(() => sendSize(preview.contentWindow, 1920, 1080));
    expect(host.textContent).toBe("1920x1080");

    act(() => root.unmount());
    preview.remove();
    secondary.remove();
  });
});
