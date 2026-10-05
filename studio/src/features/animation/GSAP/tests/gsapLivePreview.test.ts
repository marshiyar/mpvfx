// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "../../../canvas/domEditingTypes";
import { createGsapLivePreview } from "../gsapLivePreview";

describe("createGsapLivePreview", () => {
  const selection = { id: "clip", selector: "#clip" } as DomEditSelection;

  it("updates a same-origin live node", () => {
    const doc = document.implementation.createHTMLDocument();
    const el = doc.createElement("div");
    el.id = "clip";
    doc.body.append(el);
    const set = vi.fn();
    const iframe = { contentDocument: doc, contentWindow: { gsap: { set } } } as unknown as HTMLIFrameElement;
    createGsapLivePreview({ current: iframe })(selection, { x: 12 });
    expect(set).toHaveBeenCalledWith(el, { x: 12 });
  });

  it("does not throw or write when an isolated preview denies runtime access", () => {
    const iframe = {
      contentWindow: Object.defineProperty({}, "gsap", {
        get: () => { throw new DOMException("cross origin", "SecurityError"); },
      }),
      contentDocument: null,
    } as HTMLIFrameElement;
    expect(() => createGsapLivePreview({ current: iframe })(selection, { x: 12 })).not.toThrow();
  });
});
