import { STUDIO_MANUAL_EDIT_GESTURE_ATTR } from "@hyperframes/core/editing/draft-markers";

const geometryProperties = ["transform", "translate", "rotate", "scale", "width", "height", "clip-path"] as const;
const drafts = new WeakMap<HTMLElement, { token: string; styles: Array<[string, string, string]> }>();

function captureGeometry(element: HTMLElement): Array<[string, string, string]> {
  return geometryProperties.map(property => [property,
    element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]);
}

function applyGeometry(element: HTMLElement, styles: Array<[string, string, string]>): void {
  for (const [property, value, priority] of styles) {
    if (value) element.style.setProperty(property, value, priority);
    else element.style.removeProperty(property);
  }
}

/** Preserve only live gesture geometry across a synchronous committed repaint.
 * The timeline update still runs; this restores the newer picture before paint. */
export function captureActiveGestureGeometry(document: Document | null | undefined): () => void {
  const active = Array.from(document?.querySelectorAll?.<HTMLElement>(`[${STUDIO_MANUAL_EDIT_GESTURE_ATTR}]`) ?? [])
    .filter(element => element.style)
    .map(element => {
      const picture = element.id ? document?.getElementById(`__hf_color_grading_${element.id}`) : null;
      return {
        element,
        token: element.getAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR),
        styles: captureGeometry(element),
        picture: picture?.hasAttribute("data-hf-color-grading-canvas") ? picture : null,
        pictureStyles: picture?.hasAttribute("data-hf-color-grading-canvas") ? captureGeometry(picture) : null,
      };
    });
  return () => {
    for (const draft of active) {
      if (!draft.token || draft.element.getAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR) !== draft.token) continue;
      applyGeometry(draft.element, draft.styles);
      if (draft.picture && draft.pictureStyles) applyGeometry(draft.picture, draft.pictureStyles);
    }
  };
}

/** Keep an in-flight gesture authoritative across retained runtime repaints.
 * This is transient picture state, never persisted or included in export. */
export function captureNativeGestureDraft(element: HTMLElement): void {
  const token = element.getAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR);
  if (!token || !element.hasAttribute("data-studio-native-owned")) return;
  drafts.set(element, { token, styles: captureGeometry(element) });
}

export function applyNativeGestureDraft(element: HTMLElement): void {
  const draft = drafts.get(element);
  if (!draft) return;
  if (element.getAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR) !== draft.token) {
    drafts.delete(element);
    return;
  }
  applyGeometry(element, draft.styles);
}
