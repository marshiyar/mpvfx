import { STUDIO_MANUAL_EDIT_GESTURE_ATTR } from "@hyperframes/core/editing/draft-markers";

const geometryProperties = ["transform", "translate", "rotate", "scale", "width", "height", "clip-path"] as const;
const drafts = new WeakMap<HTMLElement, { token: string; styles: Array<[string, string, string]> }>();

/** Keep an in-flight gesture authoritative across retained runtime repaints.
 * This is transient picture state, never persisted or included in export. */
export function captureNativeGestureDraft(element: HTMLElement): void {
  const token = element.getAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR);
  if (!token || !element.hasAttribute("data-studio-native-owned")) return;
  drafts.set(element, { token, styles: geometryProperties.map(property => [property,
    element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]) });
}

export function applyNativeGestureDraft(element: HTMLElement): void {
  const draft = drafts.get(element);
  if (!draft) return;
  if (element.getAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR) !== draft.token) {
    drafts.delete(element);
    return;
  }
  for (const [property, value, priority] of draft.styles) {
    if (value) element.style.setProperty(property, value, priority);
    else element.style.removeProperty(property);
  }
}
