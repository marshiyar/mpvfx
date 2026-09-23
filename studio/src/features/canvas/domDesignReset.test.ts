// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  applyDomDesignResetToElement,
  buildDomDesignResetOperations,
  captureDomDesignResetState,
  restoreDomDesignResetState,
} from "./domDesignReset";
import {
  STUDIO_OFFSET_X_PROP,
  STUDIO_OFFSET_Y_PROP,
  STUDIO_ORIGINAL_INLINE_ROTATE_ATTR,
  STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR,
  STUDIO_ORIGINAL_ROTATE_ATTR,
  STUDIO_ORIGINAL_ROTATION_TRANSFORM_ORIGIN_ATTR,
  STUDIO_ORIGINAL_SCALE_ATTR,
  STUDIO_ORIGINAL_TRANSFORM_DISPLAY_ATTR,
  STUDIO_ORIGINAL_TRANSFORM_ORIGIN_ATTR,
  STUDIO_ORIGINAL_TRANSLATE_ATTR,
  STUDIO_PATH_OFFSET_ATTR,
  STUDIO_ROTATION_ATTR,
  STUDIO_ROTATION_DRAFT_ATTR,
  STUDIO_ROTATION_PROP,
} from "./manualEditsTypes";

const TRANSFORM_STYLE_PROPERTIES = [
  "translate",
  "rotate",
  "scale",
  "transform",
  "transform-origin",
  "transform-box",
  "transform-style",
  "perspective",
  "perspective-origin",
  "backface-visibility",
  STUDIO_OFFSET_X_PROP,
  STUDIO_OFFSET_Y_PROP,
  STUDIO_ROTATION_PROP,
] as const;

const MANUAL_TRANSFORM_ATTRIBUTES = [
  STUDIO_PATH_OFFSET_ATTR,
  STUDIO_ORIGINAL_TRANSLATE_ATTR,
  STUDIO_ORIGINAL_INLINE_TRANSLATE_ATTR,
  STUDIO_ROTATION_ATTR,
  STUDIO_ROTATION_DRAFT_ATTR,
  STUDIO_ORIGINAL_ROTATE_ATTR,
  STUDIO_ORIGINAL_INLINE_ROTATE_ATTR,
  STUDIO_ORIGINAL_ROTATION_TRANSFORM_ORIGIN_ATTR,
  STUDIO_ORIGINAL_TRANSFORM_DISPLAY_ATTR,
  STUDIO_ORIGINAL_SCALE_ATTR,
  STUDIO_ORIGINAL_TRANSFORM_ORIGIN_ATTR,
] as const;

function manualTransformAttributeValue(
  attribute: (typeof MANUAL_TRANSFORM_ATTRIBUTES)[number],
): string {
  if (attribute === STUDIO_ORIGINAL_TRANSFORM_DISPLAY_ATTR) return "inline";
  return attribute.includes("original") ? "before" : "true";
}

describe("total Design reset", () => {
  it("adds authored 2D/3D transforms and Studio manual X/Y/rotation state to one removal batch", () => {
    const element = document.createElement("div");
    const values: Record<(typeof TRANSFORM_STYLE_PROPERTIES)[number], string> = {
      translate: "12px -8px",
      rotate: "22deg",
      scale: "1.25",
      transform: "translateZ(40px) rotateX(12deg)",
      "transform-origin": "30% 40% 20px",
      "transform-box": "border-box",
      "transform-style": "preserve-3d",
      perspective: "900px",
      "perspective-origin": "40% 60%",
      "backface-visibility": "hidden",
      [STUDIO_OFFSET_X_PROP]: "12px",
      [STUDIO_OFFSET_Y_PROP]: "-8px",
      [STUDIO_ROTATION_PROP]: "22deg",
    };
    for (const property of TRANSFORM_STYLE_PROPERTIES) {
      element.style.setProperty(property, values[property]);
    }
    for (const attribute of MANUAL_TRANSFORM_ATTRIBUTES) {
      element.setAttribute(attribute, manualTransformAttributeValue(attribute));
    }

    expect(buildDomDesignResetOperations(element)).toEqual([
      ...TRANSFORM_STYLE_PROPERTIES.map((property) => ({
        type: "inline-style" as const,
        property,
        value: null,
      })),
      { type: "inline-style", property: "display", value: "inline" },
      ...MANUAL_TRANSFORM_ATTRIBUTES.map((property) => ({
        type: "attribute" as const,
        property,
        value: null,
      })),
    ]);
  });

  it("does not manufacture transform removals when no transform state is authored", () => {
    const element = document.createElement("video");
    element.style.setProperty("--unrelated-token", "7");
    element.setAttribute("src", "clip.mp4");
    element.setAttribute("data-duration", "12");
    expect(buildDomDesignResetOperations(element)).toEqual([]);
  });

  it("atomically restores an inline element's display promotion and rolls it back on failure", () => {
    const element = document.createElement("span");
    element.style.setProperty("display", "inline-block");
    element.setAttribute(STUDIO_ORIGINAL_TRANSFORM_DISPLAY_ATTR, "");
    const before = captureDomDesignResetState(element);

    expect(buildDomDesignResetOperations(element)).toEqual([
      { type: "inline-style", property: "display", value: null },
      {
        type: "attribute",
        property: STUDIO_ORIGINAL_TRANSFORM_DISPLAY_ATTR,
        value: null,
      },
    ]);

    applyDomDesignResetToElement(element);
    expect(element.style.getPropertyValue("display")).toBe("");
    expect(element.hasAttribute(STUDIO_ORIGINAL_TRANSFORM_DISPLAY_ATTR)).toBe(false);

    restoreDomDesignResetState(element, before);
    expect(element.style.getPropertyValue("display")).toBe("inline-block");
    expect(element.getAttribute(STUDIO_ORIGINAL_TRANSFORM_DISPLAY_ATTR)).toBe("");
  });

  it("builds one safe operation batch for authored appearance and grade state", () => {
    const element = document.createElement("video");
    element.style.cssText =
      "opacity: .4; filter: blur(8px); object-fit: cover; color: red; --unrelated-token: 7";
    element.setAttribute("data-color-grading", '{"preset":"clean-studio"}');
    element.setAttribute("src", "clip.mp4");
    element.setAttribute("data-duration", "12");

    expect(buildDomDesignResetOperations(element)).toEqual([
      { type: "inline-style", property: "color", value: null },
      { type: "inline-style", property: "filter", value: null },
      { type: "inline-style", property: "opacity", value: null },
      { type: "inline-style", property: "object-fit", value: null },
      { type: "attribute", property: "color-grading", value: null },
    ]);
  });

  it("applies and can roll back the same reset without touching source, timing, or unrelated styles", () => {
    const element = document.createElement("video");
    element.style.cssText = "opacity: .4; filter: blur(8px); --unrelated-token: 7";
    element.setAttribute("data-color-grading", '{"effects":{"blur":1}}');
    element.setAttribute("src", "clip.mp4");
    element.setAttribute("data-duration", "12");
    const before = captureDomDesignResetState(element);

    applyDomDesignResetToElement(element);
    expect(element.style.opacity).toBe("");
    expect(element.style.filter).toBe("");
    expect(element.style.getPropertyValue("--unrelated-token")).toBe("7");
    expect(element.hasAttribute("data-color-grading")).toBe(false);
    expect(element.getAttribute("src")).toBe("clip.mp4");
    expect(element.getAttribute("data-duration")).toBe("12");

    restoreDomDesignResetState(element, before);
    expect(element.style.opacity).toBe(".4");
    expect(element.style.filter).toBe("blur(8px)");
    expect(element.style.getPropertyValue("--unrelated-token")).toBe("7");
    expect(element.getAttribute("data-color-grading")).toBe('{"effects":{"blur":1}}');
  });

  it("applies and rolls back transform state without touching content, media, timing, motion, or unrelated variables", () => {
    const element = document.createElement("video");
    element.innerHTML = '<track kind="captions" src="captions.vtt">';
    element.setAttribute("src", "clip.mp4");
    element.setAttribute("poster", "poster.jpg");
    element.setAttribute("data-start", "2");
    element.setAttribute("data-duration", "12");
    element.setAttribute("data-hf-studio-motion", '{"kind":"gsap-motion"}');
    element.setAttribute("data-project-token", "keep-me");
    element.style.setProperty("--unrelated-token", "7");
    element.style.setProperty("animation-delay", "2s");

    const values: Record<(typeof TRANSFORM_STYLE_PROPERTIES)[number], string> = {
      translate: "12px -8px",
      rotate: "22deg",
      scale: "1.25",
      transform: "translateZ(40px) rotateX(12deg)",
      "transform-origin": "30% 40% 20px",
      "transform-box": "border-box",
      "transform-style": "preserve-3d",
      perspective: "900px",
      "perspective-origin": "40% 60%",
      "backface-visibility": "hidden",
      [STUDIO_OFFSET_X_PROP]: "12px",
      [STUDIO_OFFSET_Y_PROP]: "-8px",
      [STUDIO_ROTATION_PROP]: "22deg",
    };
    for (const property of TRANSFORM_STYLE_PROPERTIES) {
      element.style.setProperty(property, values[property]);
    }
    for (const attribute of MANUAL_TRANSFORM_ATTRIBUTES) {
      element.setAttribute(attribute, manualTransformAttributeValue(attribute));
    }
    const originalContent = element.innerHTML;
    const before = captureDomDesignResetState(element);

    applyDomDesignResetToElement(element);
    for (const property of TRANSFORM_STYLE_PROPERTIES) {
      expect(element.style.getPropertyValue(property), property).toBe("");
    }
    for (const attribute of MANUAL_TRANSFORM_ATTRIBUTES) {
      expect(element.hasAttribute(attribute), attribute).toBe(false);
    }
    expect(element.innerHTML).toBe(originalContent);
    expect(element.getAttribute("src")).toBe("clip.mp4");
    expect(element.getAttribute("poster")).toBe("poster.jpg");
    expect(element.getAttribute("data-start")).toBe("2");
    expect(element.getAttribute("data-duration")).toBe("12");
    expect(element.getAttribute("data-hf-studio-motion")).toBe('{"kind":"gsap-motion"}');
    expect(element.getAttribute("data-project-token")).toBe("keep-me");
    expect(element.style.getPropertyValue("--unrelated-token")).toBe("7");
    expect(element.style.getPropertyValue("animation-delay")).toBe("2s");

    restoreDomDesignResetState(element, before);
    for (const property of TRANSFORM_STYLE_PROPERTIES) {
      expect(element.style.getPropertyValue(property), property).toBe(values[property]);
    }
    for (const attribute of MANUAL_TRANSFORM_ATTRIBUTES) {
      expect(element.getAttribute(attribute), attribute).toBe(
        manualTransformAttributeValue(attribute),
      );
    }
    expect(element.innerHTML).toBe(originalContent);
    expect(element.getAttribute("src")).toBe("clip.mp4");
    expect(element.getAttribute("data-duration")).toBe("12");
    expect(element.style.getPropertyValue("--unrelated-token")).toBe("7");
  });
});
