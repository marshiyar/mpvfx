/** Small authored CSS subset safe to mirror into an isolated project preview. */
export const REMOTE_VISUAL_FIELDS = [
  { property: "border-color", label: "Border color", placeholder: "#ffffff", pattern: /^#[0-9a-f]{3,8}$/i },
  { property: "border-width", label: "Border width", placeholder: "1px", pattern: /^(?:0|[1-9]|[12]\d|3[0-2])px$/ },
  { property: "border-style", label: "Border style", options: ["none", "solid", "dashed", "dotted", "double"] },
  { property: "box-shadow", label: "Box shadow", placeholder: "0px 4px 12px #000000", pattern:
    /^(?:none|(?:-?\d{1,3}px ){2}(?:\d{1,3}px )?(?:\d{1,3}px )?#[0-9a-f]{3,8})$/i },
  { property: "filter", label: "Blur filter", placeholder: "blur(4px)", pattern: /^(?:none|blur\((?:\d{1,2}(?:\.\d{1,2})?)px\))$/ },
  { property: "backdrop-filter", label: "Backdrop blur", placeholder: "blur(4px)", pattern:
    /^(?:none|blur\((?:\d{1,2}(?:\.\d{1,2})?)px\))$/ },
  { property: "mix-blend-mode", label: "Blend mode", options:
    ["normal", "multiply", "screen", "overlay", "darken", "lighten", "difference"] },
  { property: "background-image", label: "Two color gradient", placeholder: "linear-gradient(90deg,#000000,#ffffff)", pattern:
    /^linear-gradient\((?:0|90|180|270)deg,#[0-9a-f]{3,8},#[0-9a-f]{3,8}\)$/i },
  { property: "object-fit", label: "Media fit", options: ["fill", "contain", "cover", "none", "scale-down"] },
  { property: "object-position", label: "Media position", options:
    ["center", "left", "right", "top", "bottom", "left top", "right top", "left bottom", "right bottom"] },
  { property: "text-transform", label: "Text case", options: ["none", "capitalize", "uppercase", "lowercase"] },
  { property: "font-style", label: "Font style", options: ["normal", "italic", "oblique"] },
  { property: "font-family", label: "Font family", options:
    ["Arial", "Georgia", "Verdana", "Times New Roman", "sans-serif", "serif", "monospace"] },
  { property: "letter-spacing", label: "Letter spacing", placeholder: "1px", pattern:
    /^(?:normal|-?\d{1,2}(?:\.\d{1,2})?px)$/ },
  { property: "line-height", label: "Line height", placeholder: "1.5", pattern:
    /^(?:normal|[1-4](?:\.\d{1,2})?)$/ },
  { property: "overflow", label: "Overflow", options: ["visible", "hidden", "clip", "scroll", "auto"] },
] as const;

export type RemoteVisualProperty = (typeof REMOTE_VISUAL_FIELDS)[number]["property"];

export function validRemoteVisualStyle(property: string, value: string | null): boolean {
  const field = REMOTE_VISUAL_FIELDS.find(candidate => candidate.property === property);
  if (!field) return false;
  if (value === null) return true;
  if (value.length === 0 || value.length > 128) return false;
  if ("options" in field) return (field.options as readonly string[]).includes(value);
  return field.pattern.test(value);
}
