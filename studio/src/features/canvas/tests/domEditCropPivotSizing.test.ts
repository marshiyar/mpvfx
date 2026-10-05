// @vitest-environment happy-dom

import { expect, it } from "vitest";
import { readCropCenterOffsetFraction } from "../domEditOverlayCrop";

it("uses the rendered CSS box for a percentage-sized crop", () => {
  const element = document.createElement("div");
  element.style.cssText = "width: 50%; height: 50%; clip-path: inset(10px 20px 30px 40px)";
  Object.defineProperty(element, "offsetWidth", { configurable: true, value: 200 });
  Object.defineProperty(element, "offsetHeight", { configurable: true, value: 100 });
  document.body.append(element);
  expect(readCropCenterOffsetFraction(element)).toEqual({ x: 0.05, y: -0.1 });
  element.remove();
});
