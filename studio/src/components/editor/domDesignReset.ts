import type { PatchOperation } from "../../utils/sourcePatcher";
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

/**
 * Authored appearance properties owned by the Design inspector.
 *
 * Content identity (`src`), clip timing, playback controls, and unrelated CSS
 * variables are deliberately outside this list. Their section-level resets
 * remain available without making the total Design reset destructive.
 */
export const DESIGN_RESET_STYLE_PROPERTIES = [
  "font-family",
  "font-size",
  "font-weight",
  "letter-spacing",
  "line-height",
  "text-align",
  "text-transform",
  "font-style",
  "color",
  "background-color",
  "background-image",
  "background-position",
  "background-repeat",
  "background-size",
  "border-width",
  "border-style",
  "border-color",
  "border-radius",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "box-shadow",
  "mix-blend-mode",
  "filter",
  "backdrop-filter",
  "overflow",
  "clip-path",
  "opacity",
  "z-index",
  "flex-direction",
  "justify-content",
  "align-items",
  "gap",
  // Stable 2D/3D layout transforms. These are visual Design state, unlike
  // animation timing/motion metadata, which remains intact across a reset.
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
  // Studio's manual path-offset/rotation values are authored CSS variables,
  // so they belong to the same atomic removal/rollback payload. Arbitrary CSS
  // variables are intentionally not enumerated and therefore survive.
  STUDIO_OFFSET_X_PROP,
  STUDIO_OFFSET_Y_PROP,
  STUDIO_ROTATION_PROP,
  "object-fit",
  "object-position",
] as const;

const DESIGN_RESET_DATA_ATTRIBUTES = [
  "color-grading",
  // Stable manual-transform bookkeeping must be cleared with its styles. A
  // marker left behind would make seek/reapply logic treat a reset transform
  // as still active. Content, media, timing, motion, and box-size attributes
  // are deliberately outside this list.
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

export interface DomDesignResetState {
  styles: Map<string, string>;
  dataAttributes: Map<string, string | null>;
}

function fullDataAttribute(key: string): string {
  return key.startsWith("data-") ? key : `data-${key}`;
}

export function buildDomDesignResetOperations(element: HTMLElement): PatchOperation[] {
  const styleOperations: PatchOperation[] = DESIGN_RESET_STYLE_PROPERTIES.filter(
    (property) => element.style.getPropertyValue(property) !== "",
  ).map((property) => ({ type: "inline-style", property, value: null }));
  const originalTransformDisplay = element.getAttribute(STUDIO_ORIGINAL_TRANSFORM_DISPLAY_ATTR);
  if (originalTransformDisplay !== null) {
    styleOperations.push({
      type: "inline-style",
      property: "display",
      value: originalTransformDisplay || null,
    });
  }
  const dataOperations: PatchOperation[] = DESIGN_RESET_DATA_ATTRIBUTES.filter((property) =>
    element.hasAttribute(fullDataAttribute(property)),
  ).map((property) => ({ type: "attribute", property, value: null }));
  return [...styleOperations, ...dataOperations];
}

export function captureDomDesignResetState(element: HTMLElement): DomDesignResetState {
  return {
    styles: new Map(
      [
        ...DESIGN_RESET_STYLE_PROPERTIES,
        // Manual transform editing may promote inline content to inline-block.
        // Capture it for optimistic rollback without making all authored
        // `display` values part of the total Design reset.
        "display",
      ].map((property) => [property, element.style.getPropertyValue(property)]),
    ),
    dataAttributes: new Map(
      DESIGN_RESET_DATA_ATTRIBUTES.map((property) => [
        property,
        element.getAttribute(fullDataAttribute(property)),
      ]),
    ),
  };
}

export function applyDomDesignResetToElement(element: HTMLElement): void {
  for (const property of DESIGN_RESET_STYLE_PROPERTIES) element.style.removeProperty(property);
  const originalTransformDisplay = element.getAttribute(STUDIO_ORIGINAL_TRANSFORM_DISPLAY_ATTR);
  if (originalTransformDisplay !== null) {
    if (originalTransformDisplay === "") element.style.removeProperty("display");
    else element.style.setProperty("display", originalTransformDisplay);
  }
  for (const property of DESIGN_RESET_DATA_ATTRIBUTES) {
    element.removeAttribute(fullDataAttribute(property));
  }
}

export function restoreDomDesignResetState(
  element: HTMLElement,
  state: DomDesignResetState,
): void {
  for (const property of DESIGN_RESET_STYLE_PROPERTIES) {
    const value = state.styles.get(property) ?? "";
    if (value === "") element.style.removeProperty(property);
    else element.style.setProperty(property, value);
  }
  const display = state.styles.get("display") ?? "";
  if (display === "") element.style.removeProperty("display");
  else element.style.setProperty("display", display);
  for (const property of DESIGN_RESET_DATA_ATTRIBUTES) {
    const fullAttribute = fullDataAttribute(property);
    const value = state.dataAttributes.get(property) ?? null;
    if (value === null) element.removeAttribute(fullAttribute);
    else element.setAttribute(fullAttribute, value);
  }
}
