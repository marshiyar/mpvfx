import { STUDIO_MANUAL_EDIT_GESTURE_ATTR } from "@hyperframes/core/editing/draft-markers";

const geometryProperties = ["transform", "translate", "rotate", "scale", "width", "height", "clip-path"] as const;
type Geometry = Array<[string, string, string]>;
interface GestureDraft { token: string; styles: Geometry }
export interface NativeGestureCommitCandidate extends GestureDraft { element: HTMLElement }
interface CommittedDraft { projectId: string; revision: number; styles: Geometry }
const drafts = new WeakMap<HTMLElement, GestureDraft>();
const committedDrafts = new WeakMap<HTMLElement, CommittedDraft>();
const committedElements = new WeakMap<Document, Set<HTMLElement>>();

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

/** Preserve active and revision-held gesture geometry across a synchronous GSAP repaint.
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
  // A save can finish before the replacement runtime is installed. The manual
  // marker has ended by then, but GSAP may still tick the previous revision.
  // Restore the committed pose from its snapshot, not from the stale frame that
  // happened to be on the element when this tick began.
  const committed = Array.from(document ? committedElements.get(document) ?? [] : [])
    .filter(element => !element.hasAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR))
    .map(element => ({ element, draft: committedDrafts.get(element) }))
    .filter((entry): entry is { element: HTMLElement; draft: CommittedDraft } => Boolean(entry.draft));
  return () => {
    for (const draft of active) {
      if (!draft.token || draft.element.getAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR) !== draft.token) continue;
      applyGeometry(draft.element, draft.styles);
      if (draft.picture && draft.pictureStyles) applyGeometry(draft.picture, draft.pictureStyles);
    }
    for (const { element, draft } of committed) {
      if (element.hasAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR) || committedDrafts.get(element) !== draft) continue;
      applyGeometry(element, draft.styles);
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

/** Snapshot the released picture before an asynchronous save can overlap another gesture. */
export function captureNativeGestureCommitCandidate(element: HTMLElement): NativeGestureCommitCandidate | null {
  const token = element.getAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR);
  if (!token || !element.hasAttribute("data-studio-native-owned")) return null;
  return { element, token, styles: captureGeometry(element) };
}

/** A durable write has completed, but the preview may still evaluate the old revision. */
export function retainCommittedNativeGestureDraft(
  candidate: NativeGestureCommitCandidate | null,
  projectId: string,
  revision: number,
): void {
  if (!candidate || !Number.isSafeInteger(revision) || revision < 0) return;
  const { element } = candidate;
  const prior = committedDrafts.get(element);
  if (prior?.projectId === projectId && prior.revision > revision) return;
  committedDrafts.set(element, { projectId, revision, styles: candidate.styles });
  const owner = element.ownerDocument;
  let elements = committedElements.get(owner);
  if (!elements) {
    elements = new Set();
    committedElements.set(owner, elements);
  }
  elements.add(element);
}

/** Called only after an adapter for this revision has installed into this document. */
export function releaseCommittedNativeGestureDrafts(document: Document, projectId: string, revision: number): void {
  const elements = committedElements.get(document);
  if (!elements) return;
  for (const element of elements) {
    const pending = committedDrafts.get(element);
    if (!pending || (pending.projectId === projectId && revision >= pending.revision)) {
      committedDrafts.delete(element);
      elements.delete(element);
    }
  }
  if (elements.size === 0) committedElements.delete(document);
}

/** Project boundaries must not carry a preview-only picture into another project. */
export function discardCommittedNativeGestureDrafts(document: Document): void {
  const elements = committedElements.get(document);
  if (!elements) return;
  for (const element of elements) committedDrafts.delete(element);
  committedElements.delete(document);
}

export function applyNativeGestureDraft(element: HTMLElement): void {
  const draft = drafts.get(element);
  if (draft && element.getAttribute(STUDIO_MANUAL_EDIT_GESTURE_ATTR) === draft.token) {
    applyGeometry(element, draft.styles);
    return;
  }
  if (draft) {
    drafts.delete(element);
  }
  const committed = committedDrafts.get(element);
  if (committed) applyGeometry(element, committed.styles);
}
