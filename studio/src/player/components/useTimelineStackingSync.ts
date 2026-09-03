import { useCallback, useEffect, type RefObject } from "react";
import type { TimelineElement } from "../store/playerStore";
import { useDomEditActionsContextOptional } from "../../contexts/DomEditContext";
import { useStudioShellContextOptional } from "../../contexts/StudioContext";
import { findElementForSelection } from "../../components/editor/domEditingElement";
import { readEffectiveZIndex } from "../../components/editor/canvasContextMenuZOrder";
import type { StackingPatch } from "./timelineStackingSync";
import { computeStackingPatches } from "./timelineStackingSync";

interface UseTimelineStackingSyncInput {
  expandedElementsRef: RefObject<TimelineElement[]>;
  expandedElements?: TimelineElement[];
}

// Lane ↔ stacking unification (research/STAGE3-NEEDED-WIRING.md). Provision the
// two deps commitDraggedClipMove accepts so a lane-change drag also patches the
// edited clip's z-index. Both read the SAME preview iframe + z-order persist path
// the canvas right-click menu / LayersPanel use, so a timeline lane move and a
// menu z-edit produce one shared inline-style commit shape. Optional contexts:
// outside the NLE (standalone <Timeline>) these are null ⇒ deps undefined ⇒ the
// commit's z-sync is a no-op (backward compatible).
export function useTimelineStackingSync({
  expandedElementsRef,
  expandedElements,
}: UseTimelineStackingSyncInput) {
  const domEditActions = useDomEditActionsContextOptional();
  const shell = useStudioShellContextOptional();
  const zSyncPreviewIframeRef = domEditActions?.previewIframeRef ?? null;
  const handleDomZIndexReorderCommit = domEditActions?.handleDomZIndexReorderCommit;
  const zSyncActiveCompPath = shell?.activeCompPath ?? null;

  // Resolve a TimelineElement to its live iframe HTMLElement via the same
  // hfId ?? id ?? selector[selectorIndex] resolver the timeline's DOM patches use.
  const resolveIframeElement = useCallback(
    (el: TimelineElement): HTMLElement | null => {
      const doc = zSyncPreviewIframeRef?.current?.contentDocument ?? null;
      if (!doc) return null;
      return findElementForSelection(
        doc,
        {
          hfId: el.hfId,
          id: el.domId ?? el.id,
          selector: el.selector,
          selectorIndex: el.selectorIndex,
          sourceFile: el.sourceFile ?? zSyncActiveCompPath ?? "index.html",
        },
        zSyncActiveCompPath,
      );
    },
    [zSyncPreviewIframeRef, zSyncActiveCompPath],
  );

  // NaN (NOT 0) when the element can't be resolved in the preview iframe — a
  // nested / unmounted sub-comp node, or one outside the active file. Fabricating
  // z=0 would enter computeStackingPatches as a real overlapping neighbour at the
  // z-floor and skew the boundary math; a non-finite value tells it to EXCLUDE this
  // clip instead. NaN (rather than null) keeps the return assignable to the
  // `(el) => number` reader contract the drag hook / commit deps declare.
  const readClipZIndex = useCallback(
    (el: TimelineElement): number => {
      const node = resolveIframeElement(el);
      return node ? readEffectiveZIndex(node) : Number.NaN;
    },
    [resolveIframeElement],
  );

  const applyStackingPatches = useCallback(
    (patches: StackingPatch[], coalesceKey?: string) => {
      if (!handleDomZIndexReorderCommit) return Promise.resolve();
      const entries = patches.flatMap((p) => {
        const el = expandedElementsRef.current.find((e) => (e.key ?? e.id) === p.key);
        const node = el && resolveIframeElement(el);
        if (!el || !node) return [];
        return [
          {
            element: node,
            zIndex: p.zIndex,
            id: el.domId ?? el.id,
            selector: el.selector,
            selectorIndex: el.selectorIndex,
            sourceFile: el.sourceFile ?? zSyncActiveCompPath ?? "index.html",
            // The store key: lets the commit update the store's zIndex
            // synchronously (and roll it back on failure).
            key: p.key,
          },
        ];
      });
      // Forward the drag-commit's shared coalesce key so the z-reorder history
      // entry merges with the lane change's move entry into one undo step.
      return entries.length
        ? handleDomZIndexReorderCommit(entries, coalesceKey).then(() => undefined)
        : Promise.resolve();
    },
    [handleDomZIndexReorderCommit, resolveIframeElement, zSyncActiveCompPath, expandedElementsRef],
  );

  // Engage the z-sync only when the persist path is present (inside the NLE).
  const zSyncEnabled = Boolean(handleDomZIndexReorderCommit && zSyncPreviewIframeRef);

  // Older Studio imports assigned z by insertion order, which could leave a
  // lower timeline row painting over an upper one after reopening the project.
  // Reconcile only overlapping visual clips, through the normal durable
  // z-reorder path, so existing projects adopt the lane-order invariant too.
  useEffect(() => {
    if (!zSyncEnabled || !expandedElements) return;
    const stackingElements = expandedElements.map((element, domIndex) => ({
      key: element.key ?? element.id,
      start: element.start,
      duration: element.duration,
      track: element.track,
      zIndex: readClipZIndex(element),
      isAudio: element.kind === "audio" || element.tag === "audio",
      sourceFile: element.sourceFile ?? zSyncActiveCompPath ?? "index.html",
      stackingContextId: element.stackingContextId ?? null,
      domIndex,
    }));
    const patches = computeStackingPatches(
      stackingElements,
      stackingElements.filter((element) => !element.isAudio).map((element) => element.key),
    );
    if (patches.length > 0) {
      void applyStackingPatches(patches, "timeline-stacking-reconcile").catch((error) => {
        console.error("[Timeline] Failed to reconcile lane stacking", error);
      });
    }
  }, [
    applyStackingPatches,
    expandedElements,
    readClipZIndex,
    zSyncActiveCompPath,
    zSyncEnabled,
  ]);

  return { readClipZIndex, applyStackingPatches, zSyncEnabled };
}
