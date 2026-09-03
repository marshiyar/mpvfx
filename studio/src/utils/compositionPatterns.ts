/** Matches the opening tag of a composition root element (e.g. `<div data-composition-id="main">`). */
export const COMPOSITION_ROOT_OPEN_TAG_RE =
  /<[^>]*\bdata-composition-id\s*=\s*(["'])[^"']+\1[^>]*>/i;
