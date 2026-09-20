// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { getCuratedComputedStyles, getInlineStyles } from "./domEditingDom";

afterEach(() => document.body.replaceChildren());

it("reads the visible graded picture's opacity instead of its hidden source", () => {
  const source = document.createElement("img");
  source.id = "graded";
  source.setAttribute("data-hf-color-grading-source-hidden", "true");
  source.setAttribute("data-hf-authored-opacity", "0.8");
  source.style.setProperty("opacity", "0", "important");
  const canvas = document.createElement("canvas");
  canvas.id = "__hf_color_grading_graded";
  canvas.setAttribute("data-hf-color-grading-canvas", "true");
  canvas.style.opacity = "0.6";
  document.body.append(source, canvas);
  expect(getCuratedComputedStyles(source).opacity).toBe("0.6");
  expect(getInlineStyles(source).opacity).toBe("0.8");
  source.setAttribute("data-studio-native-opacity", "0.4");
  expect(getCuratedComputedStyles(source).opacity).toBe("0.4");
});

it("preserves intentionally transparent media without an effect replacement", () => {
  const source = document.createElement("img");
  source.style.opacity = "0";
  document.body.append(source);
  expect(getCuratedComputedStyles(source).opacity).toBe("0");
  expect(getInlineStyles(source).opacity).toBe("0");
});
