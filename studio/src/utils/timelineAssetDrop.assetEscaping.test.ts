// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildTimelineAssetInsertHtml } from "./timelineAssetDrop";

describe("timeline media filename escaping", () => {
  it("round-trips reserved filename characters without creating injected attributes", () => {
    const assetPath = 'assets/shot" onerror="alert(1)&draft<final>.png';
    const markup = buildTimelineAssetInsertHtml({
      id: "safe-id",
      hfId: "hf-safe-id",
      assetPath,
      kind: "image",
      start: 0,
      duration: 5,
      track: 0,
      zIndex: 1,
    });
    const document = new DOMParser().parseFromString(markup, "text/html");
    const image = document.querySelector("img#safe-id");

    expect(image?.getAttribute("src")).toBe(assetPath);
    expect(image?.hasAttribute("onerror")).toBe(false);
    expect(markup).toContain("&quot;");
    expect(markup).toContain("&amp;");
    expect(markup).toContain("&lt;");
    expect(markup).toContain("&gt;");
  });
});
