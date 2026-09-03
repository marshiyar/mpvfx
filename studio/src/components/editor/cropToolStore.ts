import { create } from "zustand";
import type { CropLinkState } from "./domEditOverlayCrop";
import { buildInsetClipPathSides, type ClipPathInsetSides } from "./clipPathHelpers";
import { didCropCommitLand } from "./cropCommitOutcome";

export const INDEPENDENT_CROP_LINKS: CropLinkState = {
  all: false,
  vertical: false,
  horizontal: false,
};

export const EMPTY_CROP_INSETS: ClipPathInsetSides = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

interface CropToolState {
  /** Selection identity currently in explicit crop mode. */
  targetKey: string | null;
  targetElement: HTMLElement | null;
  links: CropLinkState;
  /** Immutable source snapshot used by Cancel and implicit cancellation. */
  originalInsets: ClipPathInsetSides;
  originalClipPath: string;
  /** Mutable, preview-only crop. It is not written to project source until Apply. */
  insets: ClipPathInsetSides;
  applying: boolean;
  activate: (
    targetKey: string,
    targetElement: HTMLElement,
    insets?: ClipPathInsetSides,
    originalClipPath?: string,
  ) => void;
  /** Safe default exit: restore the exact pre-session inline value. */
  deactivate: (expectedTargetKey?: string) => void;
  cancel: (expectedTargetKey?: string) => boolean;
  finish: (expectedTargetKey?: string) => boolean;
  setLinks: (links: CropLinkState) => void;
  previewInsets: (insets: ClipPathInsetSides) => void;
  reset: () => void;
  apply: (
    expectedTargetKey: string,
    persist: (property: string, value: string) => Promise<unknown> | unknown,
  ) => Promise<boolean>;
}

function hasCrop(insets: ClipPathInsetSides): boolean {
  return Object.values(insets).some((value) => value > 0);
}

function sameCropInsets(a: ClipPathInsetSides, b: ClipPathInsetSides): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

export function clipPathForCropDraft(insets: ClipPathInsetSides): string {
  return hasCrop(insets) ? buildInsetClipPathSides(insets, 0) : "none";
}

function restoreInlineCrop(element: HTMLElement | null, value: string): void {
  if (!element) return;
  if (value) element.style.setProperty("clip-path", value);
  else element.style.removeProperty("clip-path");
}

const CLOSED_CROP_STATE = {
  targetKey: null,
  targetElement: null,
  links: { ...INDEPENDENT_CROP_LINKS },
  originalInsets: { ...EMPTY_CROP_INSETS },
  originalClipPath: "",
  insets: { ...EMPTY_CROP_INSETS },
  applying: false,
};

/** Editor-only crop session state. It is deliberately not persisted or exported. */
export const useCropToolStore = create<CropToolState>((set, get) => ({
  ...CLOSED_CROP_STATE,
  activate: (targetKey, targetElement, insets = EMPTY_CROP_INSETS, originalClipPath = "") => {
    const current = get();
    // The in-flight write still owns this transaction. Replacing it would
    // orphan both its failure recovery and its exact pre-session snapshot.
    if (current.applying) return;
    if (current.targetKey && current.targetKey !== targetKey) {
      restoreInlineCrop(current.targetElement, current.originalClipPath);
    }
    set({
      targetKey,
      targetElement,
      links: { ...INDEPENDENT_CROP_LINKS },
      originalInsets: { ...insets },
      originalClipPath,
      insets: { ...insets },
      applying: false,
    });
  },
  deactivate: (expectedTargetKey) => {
    get().cancel(expectedTargetKey);
  },
  cancel: (expectedTargetKey) => {
    const state = get();
    if (!state.targetKey || (expectedTargetKey && state.targetKey !== expectedTargetKey)) {
      return false;
    }
    // A persistence operation cannot be rolled back merely by hiding its UI.
    // Keep the session owned until that operation reports success/failure.
    if (state.applying) return false;
    restoreInlineCrop(state.targetElement, state.originalClipPath);
    set({ ...CLOSED_CROP_STATE });
    return true;
  },
  finish: (expectedTargetKey) => {
    const state = get();
    if (!state.targetKey || (expectedTargetKey && state.targetKey !== expectedTargetKey)) {
      return false;
    }
    set({ ...CLOSED_CROP_STATE });
    return true;
  },
  setLinks: (links) => set({ links: { ...links } }),
  previewInsets: (insets) => {
    const state = get();
    if (!state.targetKey || state.applying) return;
    const next = { ...insets };
    state.targetElement?.style.setProperty("clip-path", clipPathForCropDraft(next));
    set({ insets: next });
  },
  reset: () => get().previewInsets(EMPTY_CROP_INSETS),
  apply: async (expectedTargetKey, persist) => {
    const snapshot = get();
    if (
      !snapshot.targetKey ||
      snapshot.targetKey !== expectedTargetKey ||
      snapshot.applying
    ) {
      return false;
    }
    if (sameCropInsets(snapshot.insets, snapshot.originalInsets)) {
      // Applying an untouched session should not manufacture a source edit or
      // normalize the author's equivalent shorthand formatting.
      restoreInlineCrop(snapshot.targetElement, snapshot.originalClipPath);
      get().finish(expectedTargetKey);
      return true;
    }
    const clipPath = clipPathForCropDraft(snapshot.insets);
    set({ applying: true });
    let outcome: unknown;
    try {
      outcome = await persist("clip-path", clipPath);
    } catch {
      if (get().targetKey === expectedTargetKey) set({ applying: false });
      return false;
    }
    if (!didCropCommitLand(outcome)) {
      if (get().targetKey === expectedTargetKey) {
        // The general commit path may have reverted the live style. Crop mode
        // remains open, so put the still-uncommitted draft back on screen.
        snapshot.targetElement?.style.setProperty("clip-path", clipPath);
        set({ applying: false });
      }
      return false;
    }
    // The final source write landed. The live element already carries the same
    // value, so exit without restoring the pre-session snapshot.
    get().finish(expectedTargetKey);
    return true;
  },
}));
