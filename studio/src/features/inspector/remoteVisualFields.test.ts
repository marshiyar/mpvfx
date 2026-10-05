import { describe, expect, it } from "vitest";
import { validRemoteVisualStyle } from "./remoteVisualFields";

describe("bounded remote visual styles", () => {
  it("accepts literal authored values and clearing", () => {
    expect(validRemoteVisualStyle("border-color", "#aabbcc")).toBe(true);
    expect(validRemoteVisualStyle("border-width", "3px")).toBe(true);
    expect(validRemoteVisualStyle("background-image", "linear-gradient(90deg,#000000,#ffffff)")).toBe(true);
    expect(validRemoteVisualStyle("box-shadow", "0px 4px 12px #000000")).toBe(true);
    expect(validRemoteVisualStyle("object-fit", "cover")).toBe(true);
    expect(validRemoteVisualStyle("filter", null)).toBe(true);
  });
  it("rejects URLs, expressions, unsupported functions, and arbitrary CSS", () => {
    expect(validRemoteVisualStyle("background-image", "url(https://example.com/x.png)")).toBe(false);
    expect(validRemoteVisualStyle("filter", "blur(4px) url(file:///secret)")).toBe(false);
    expect(validRemoteVisualStyle("box-shadow", "0px 0px 0px red;position:fixed")).toBe(false);
    expect(validRemoteVisualStyle("behavior", "url(test.htc)")).toBe(false);
  });
});
