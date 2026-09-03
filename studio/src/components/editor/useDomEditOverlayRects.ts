/**
 * RAF-driven hook that tracks overlay, hover, and group rects from the iframe DOM.
 * Runs a requestAnimationFrame loop and writes React state only when rects change.
 */
import { useRef, useState, type RefObject } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import {
  hugOrientedRectForElement,
  hugRectForElement,
} from "./domEditOverlayCrop";
import { type DomEditSelection, findElementForSelection } from "./domEditing";
import {
  type GroupOverlayItem,
  type OverlayRect,
  type ResolvedElementRef,
  groupOverlayItemsEqual,
  isElementVisibleForOverlay,
  groupAwareOverlayRect,
  orientedGroupAwareOverlayRect,
  rectsEqual,
  resolveElementForOverlay,
  selectionCacheKey,
  orientedVisibleOverlayRect,
} from "./domEditOverlayGeometry";

function childRectsEqual(a: OverlayRect[], b: OverlayRect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!rectsEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

/** Element identity is the final authority for overlay de-duplication. The
 * selection and hover resolvers can describe the same live node with different
 * id/selector metadata, especially immediately after a source write replaces
 * the iframe node. Drawing both records creates the old/new crop-border flicker. */
export function hoverElementDuplicatesSelection(
  hoverElement: HTMLElement,
  selectionElement: HTMLElement | null,
  groupElements: readonly HTMLElement[],
): boolean {
  return (
    hoverElement === selectionElement ||
    groupElements.some((element) => element === hoverElement)
  );
}

interface UseDomEditOverlayRectsOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  overlayRef: RefObject<HTMLDivElement | null>;
  selectionRef: RefObject<DomEditSelection | null>;
  activeCompositionPathRef: RefObject<string | null>;
  groupSelectionsRef: RefObject<DomEditSelection[]>;
  hoverSelectionRef: RefObject<DomEditSelection | null>;
  rafPausedRef: RefObject<boolean>;
}

interface UseDomEditOverlayRectsResult {
  /** The live preview node that the measured selection rect belongs to. */
  selectionElement: HTMLElement | null;
  selectionElementKey: string | null;
  overlayRect: OverlayRect | null;
  overlayRectRef: RefObject<OverlayRect | null>;
  setOverlayRect: (next: OverlayRect | null) => void;
  hoverRect: OverlayRect | null;
  hoverRectRef: RefObject<OverlayRect | null>;
  setHoverRect: (next: OverlayRect | null) => void;
  groupOverlayItems: GroupOverlayItem[];
  groupOverlayItemsRef: RefObject<GroupOverlayItem[]>;
  setGroupOverlayItems: (next: GroupOverlayItem[]) => void;
  childRects: OverlayRect[];
}

export function useDomEditOverlayRects({
  iframeRef,
  overlayRef,
  selectionRef,
  activeCompositionPathRef,
  groupSelectionsRef,
  hoverSelectionRef,
  rafPausedRef,
}: UseDomEditOverlayRectsOptions): UseDomEditOverlayRectsResult {
  const [overlayRect, setOverlayRectState] = useState<OverlayRect | null>(null);
  const [selectionElement, setSelectionElement] = useState<HTMLElement | null>(
    null,
  );
  const [selectionElementKey, setSelectionElementKey] = useState<string | null>(
    null,
  );
  const [hoverRect, setHoverRectState] = useState<OverlayRect | null>(null);
  const [groupOverlayItems, setGroupOverlayItemsState] = useState<
    GroupOverlayItem[]
  >([]);
  const [childRects, setChildRectsState] = useState<OverlayRect[]>([]);

  const overlayRectRef = useRef<OverlayRect | null>(null);
  const hoverRectRef = useRef<OverlayRect | null>(null);
  const groupOverlayItemsRef = useRef<GroupOverlayItem[]>([]);
  const resolvedElementRef = useRef<{
    key: string;
    element: HTMLElement;
  } | null>(null);
  const resolvedHoverElementRef = useRef<{
    key: string;
    element: HTMLElement;
  } | null>(null);
  const resolvedGroupElementRef = useRef<Map<string, HTMLElement>>(new Map());
  const childRectsRef = useRef<OverlayRect[]>([]);

  const setOverlayRect = (next: OverlayRect | null) => {
    if (rectsEqual(overlayRectRef.current, next)) return;
    overlayRectRef.current = next;
    setOverlayRectState(next);
  };

  const setHoverRect = (next: OverlayRect | null) => {
    if (rectsEqual(hoverRectRef.current, next)) return;
    hoverRectRef.current = next;
    setHoverRectState(next);
  };

  const setGroupOverlayItems = (next: GroupOverlayItem[]) => {
    if (groupOverlayItemsEqual(groupOverlayItemsRef.current, next)) return;
    groupOverlayItemsRef.current = next;
    setGroupOverlayItemsState(next);
  };

  const resolveGroupElement = (doc: Document, sel: DomEditSelection) => {
    const key = selectionCacheKey(sel);
    const cached = resolvedGroupElementRef.current.get(key);
    if (cached?.isConnected && cached.ownerDocument === doc) return cached;

    const next = findElementForSelection(
      doc,
      sel,
      activeCompositionPathRef.current,
    );
    if (next) {
      resolvedGroupElementRef.current.set(key, next);
    } else {
      resolvedGroupElementRef.current.delete(key);
    }
    return next;
  };

  useMountEffect(() => {
    let frame = 0;

    const clearAll = () => {
      setSelectionElement(null);
      setSelectionElementKey(null);
      setOverlayRect(null);
      setHoverRect(null);
      setGroupOverlayItems([]);
    };

    const update = () => {
      frame = requestAnimationFrame(update);
      if (rafPausedRef.current) {
        if (childRectsRef.current.length > 0) {
          childRectsRef.current = [];
          setChildRectsState([]);
        }
        return;
      }

      const sel = selectionRef.current;
      const iframe = iframeRef.current;
      const overlayEl = overlayRef.current;
      if (!iframe || !overlayEl) {
        resolvedElementRef.current = null;
        resolvedHoverElementRef.current = null;
        resolvedGroupElementRef.current.clear();
        clearAll();
        return;
      }

      const doc = iframe.contentDocument;
      if (!doc) {
        resolvedElementRef.current = null;
        resolvedHoverElementRef.current = null;
        resolvedGroupElementRef.current.clear();
        clearAll();
        return;
      }

      if (sel) {
        const el = resolveElementForOverlay(
          doc,
          sel,
          activeCompositionPathRef.current,
          resolvedElementRef as ResolvedElementRef,
        );
        // An explicitly-selected element's overlay must track it whenever it's laid
        // out and not display:none/visibility:hidden/opacity:0 — use basic visibility,
        // NOT the occlusion heuristic. Occlusion (isElementVisibleInPreview) treats any
        // opacity:1 ancestor as an opaque cover even when it paints nothing (e.g. a
        // backgroundless full-bleed scene above a subcomposition), which would wrongly
        // hide the selection box. Occlusion stays for hover, where a false hide is cheap.
        if (el && isElementVisibleForOverlay(el)) {
          setSelectionElement(el);
          setSelectionElementKey(selectionCacheKey(sel));
          // Groups render as an AABB union of their members (a group OBB is out of
          // scope); a single element renders as an oriented box that co-rotates
          // with its transform. orientedOverlayRect gates on rotation internally
          // (a cheap per-call check) and only pays for the full corner-transform
          // measurement when the element is actually rotated — this RAF loop runs
          // every frame for any single selection, so that gate matters here most.
          const nextRect = orientedGroupAwareOverlayRect(overlayEl, iframe, el);
          setOverlayRect(nextRect);
          const descendants = el.querySelectorAll("*");
          if (descendants.length > 0 && descendants.length <= 60) {
            const nextChildRects: OverlayRect[] = [];
            for (let i = 0; i < descendants.length; i++) {
              const child = descendants[i] as HTMLElement;
              if (!child.getBoundingClientRect) continue;
              // Oriented, not axis-aligned: a child of a rotated element drew its
              // outline square around the rotated glyphs instead of on them.
              const r = orientedVisibleOverlayRect(overlayEl, iframe, child);
              if (r && r.width > 2 && r.height > 2) nextChildRects.push(r);
            }
            if (!childRectsEqual(childRectsRef.current, nextChildRects)) {
              childRectsRef.current = nextChildRects;
              setChildRectsState(nextChildRects);
            }
          } else if (childRectsRef.current.length > 0) {
            childRectsRef.current = [];
            setChildRectsState([]);
          }
        } else {
          setSelectionElement(null);
          setSelectionElementKey(null);
          setOverlayRect(null);
          if (childRectsRef.current.length > 0) {
            childRectsRef.current = [];
            setChildRectsState([]);
          }
        }
      } else {
        resolvedElementRef.current = null;
        setSelectionElement(null);
        setSelectionElementKey(null);
        setOverlayRect(null);
        if (childRectsRef.current.length > 0) {
          childRectsRef.current = [];
          setChildRectsState([]);
        }
      }

      const group = groupSelectionsRef.current;
      if (group.length > 0) {
        const nextGroupItems: GroupOverlayItem[] = [];
        const liveGroupKeys = new Set<string>();
        for (const groupSelection of group) {
          const key = selectionCacheKey(groupSelection);
          // Members of the same group collapse to one selection under select-as-unit,
          // so a multi-select can hold the same group twice — dedupe by key to avoid
          // duplicate React keys (and a doubled overlay box).
          if (liveGroupKeys.has(key)) continue;
          liveGroupKeys.add(key);
          const el = resolveGroupElement(doc, groupSelection);
          const base = el ? groupAwareOverlayRect(overlayEl, iframe, el) : null;
          const rect =
            base && el ? { ...base, ...hugRectForElement(base, el) } : base;
          if (el && rect)
            nextGroupItems.push({
              key,
              selection: groupSelection,
              element: el,
              rect,
            });
        }
        for (const key of resolvedGroupElementRef.current.keys()) {
          if (!liveGroupKeys.has(key))
            resolvedGroupElementRef.current.delete(key);
        }
        setGroupOverlayItems(nextGroupItems);
      } else {
        resolvedGroupElementRef.current.clear();
        setGroupOverlayItems([]);
      }

      const hoverSel = hoverSelectionRef.current;
      const hoverMatchesSelection = Boolean(
        sel &&
        hoverSel &&
        selectionCacheKey(sel) === selectionCacheKey(hoverSel),
      );
      const hoverMatchesGroup = Boolean(
        hoverSel &&
        group.some(
          (entry) => selectionCacheKey(entry) === selectionCacheKey(hoverSel),
        ),
      );
      if (!hoverSel || hoverMatchesSelection || hoverMatchesGroup) {
        resolvedHoverElementRef.current = null;
        setHoverRect(null);
        return;
      }

      const hoverEl = resolveElementForOverlay(
        doc,
        hoverSel,
        activeCompositionPathRef.current,
        resolvedHoverElementRef as ResolvedElementRef,
      );
      if (!hoverEl) {
        setHoverRect(null);
        return;
      }

      if (
        hoverElementDuplicatesSelection(
          hoverEl,
          resolvedElementRef.current?.element ?? null,
          [...resolvedGroupElementRef.current.values()],
        )
      ) {
        resolvedHoverElementRef.current = null;
        setHoverRect(null);
        return;
      }

      const measuredHoverRect = orientedGroupAwareOverlayRect(
        overlayEl,
        iframe,
        hoverEl,
      );
      // Normalize the resolved live element exactly once here. Rendering must
      // not reapply clip margins from a stale selection snapshot.
      setHoverRect(
        measuredHoverRect
          ? hugOrientedRectForElement(measuredHoverRect, hoverEl)
          : null,
      );
    };

    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  });

  return {
    selectionElement,
    selectionElementKey,
    overlayRect,
    overlayRectRef,
    setOverlayRect,
    hoverRect,
    hoverRectRef,
    setHoverRect,
    groupOverlayItems,
    groupOverlayItemsRef,
    setGroupOverlayItems,
    childRects,
  };
}
