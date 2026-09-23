// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { hoverElementDuplicatesSelection } from "./useDomEditOverlayRects";

describe("hoverElementDuplicatesSelection", () => {
  it("suppresses a second outline when differently-shaped selection records resolve to one element", () => {
    const liveVideo = document.createElement("video");
    expect(hoverElementDuplicatesSelection(liveVideo, liveVideo, [])).toBe(
      true,
    );
  });

  it("does not suppress a genuinely different element", () => {
    expect(
      hoverElementDuplicatesSelection(
        document.createElement("video"),
        document.createElement("video"),
        [],
      ),
    ).toBe(false);
  });
});
