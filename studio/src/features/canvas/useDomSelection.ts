import { useState, useCallback, useRef, useEffect } from "react";
import type { TimelineElement } from "../../player/index";
import {
  getAllPreviewTargetsFromPointer,
  getPreviewTargetFromPointer,
} from "../preview/studioPreviewHelpers";
import {
  domEditSelectionsTargetSame,
  domEditSelectionInGroup,
  toggleDomEditGroupSelection,
  replaceDomEditGroupSelection,
  seedDomEditGroupWithSelection,
} from "./domEditHelpers";
import {
  findElementForSelection,
  findElementForTimelineElement,
  resolveDomEditSelection,
  type DomEditSelection,
} from "./domEditing";
import { reapplyPositionEditsAfterSeek } from "./manualEdits";
import { useStudioTestHooks } from "../../app/useStudioTestHooks";
import { logSelect } from "../../lib/selectDebug";
import { announceTimelineSelection as announceSelectionToTimeline } from "./domSelectionTimelineMirror";
import type {
  ApplyDomSelectionOptions,
  UseDomSelectionParams,
  UseDomSelectionReturn,
} from "./useDomSelectionTypes";

export type {
  ApplyDomSelectionOptions,
  ResolveDomSelectionOptions,
  UseDomSelectionParams,
  UseDomSelectionReturn,
} from "./useDomSelectionTypes";

// ── Hook ──

export function useDomSelection({
  projectId,
  activeCompPath,
  isMasterView,
  compIdToSrc,
  captionEditMode,
  previewIframeRef,
  timelineElements,
  getTimelineSelectionSet,
  setSelectedTimelineElementId,
  setTimelineSelectionSet,
  setRightCollapsed,
  previewIframe,
  refreshKey,
}: UseDomSelectionParams): UseDomSelectionReturn {
  // ── State ──

  const [domEditSelection, setDomEditSelection] = useState<DomEditSelection | null>(null);
  const [domEditGroupSelections, setDomEditGroupSelections] = useState<DomEditSelection[]>([]);
  const [domEditHoverSelection, setDomEditHoverSelection] = useState<DomEditSelection | null>(null);
  // The data-hf-group wrapper the user has drilled into (null = top level).
  const [activeGroupElement, setActiveGroupElementState] = useState<HTMLElement | null>(null);

  // ── Refs ──

  const domEditSelectionRef = useRef<DomEditSelection | null>(domEditSelection);
  const domEditGroupSelectionsRef = useRef<DomEditSelection[]>(domEditGroupSelections);
  const domEditHoverSelectionRef = useRef<DomEditSelection | null>(domEditHoverSelection);
  const activeGroupElementRef = useRef<HTMLElement | null>(activeGroupElement);
  const compositionIdentityRef = useRef({ activeCompPath, projectId });
  // Monotonic token so a rapid A->B timeline-clip select can't let A's slower async
  // resolution land after B and restore the wrong selection.
  const timelineSelectSeqRef = useRef(0);
  const refreshSequenceRef = useRef(0);
  const refreshMountedRef = useRef(true);
  const refreshScopeRef = useRef({ projectId, activeCompPath });
  refreshScopeRef.current = { projectId, activeCompPath };

  useEffect(() => {
    refreshMountedRef.current = true;
    return () => {
      refreshMountedRef.current = false;
      refreshSequenceRef.current += 1;
    };
  }, []);

  // Keep refs in sync with state
  domEditSelectionRef.current = domEditSelection;
  domEditGroupSelectionsRef.current = domEditGroupSelections;
  domEditHoverSelectionRef.current = domEditHoverSelection;
  activeGroupElementRef.current = activeGroupElement;

  // ── Callbacks ──

  const announceTimelineSelection = useCallback(
    (group: DomEditSelection[], primary: DomEditSelection | null) =>
      announceSelectionToTimeline(
        {
          timelineElements,
          getTimelineSelectionSet,
          setSelectedTimelineElementId,
          setTimelineSelectionSet,
        },
        group,
        primary,
      ),
    [
      getTimelineSelectionSet,
      setSelectedTimelineElementId,
      setTimelineSelectionSet,
      timelineElements,
    ],
  );

  const applyDomSelection = useCallback(
    // fallow-ignore-next-line complexity
    (selection: DomEditSelection | null, options?: ApplyDomSelectionOptions) => {
      if (!selection) {
        logSelect("clear", { hadGroup: domEditGroupSelectionsRef.current.length });
        domEditSelectionRef.current = null;
        domEditGroupSelectionsRef.current = [];
        setDomEditSelection(null);
        setDomEditGroupSelections([]);
        if (options?.announce !== false) announceTimelineSelection([], null);
        return;
      }

      const isAdditiveSelection = Boolean(options?.additive);
      const currentSelection = domEditSelectionRef.current;
      const previousGroup = domEditGroupSelectionsRef.current;
      const isRepeatedSingleSelection =
        !isAdditiveSelection &&
        !options?.preserveGroup &&
        previousGroup.length === 1 &&
        domEditSelectionsTargetSame(currentSelection, selection) &&
        domEditSelectionsTargetSame(previousGroup[0], selection);
      if (isRepeatedSingleSelection) {
        if (options?.revealPanel !== false) {
          setRightCollapsed(false);
        }
        return;
      }
      const currentGroup = isAdditiveSelection
        ? seedDomEditGroupWithSelection(previousGroup, currentSelection)
        : previousGroup;
      const wasInGroup = domEditSelectionInGroup(currentGroup, selection);
      const nextGroup = options?.preserveGroup
        ? replaceDomEditGroupSelection(currentGroup, selection)
        : isAdditiveSelection
          ? toggleDomEditGroupSelection(currentGroup, selection)
          : [selection];
      const nextSelection = options?.preserveGroup
        ? selection
        : isAdditiveSelection && wasInGroup
          ? domEditSelectionsTargetSame(currentSelection, selection)
            ? (nextGroup[0] ?? null)
            : domEditSelectionInGroup(nextGroup, currentSelection)
              ? currentSelection
              : (nextGroup[0] ?? null)
          : selection;

      logSelect("apply", {
        additive: isAdditiveSelection,
        target: selection.selector ?? selection.id ?? null,
        wasInGroup,
        prevGroup: previousGroup.length,
        nextGroup: nextGroup.length,
      });
      domEditSelectionRef.current = nextSelection;
      domEditGroupSelectionsRef.current = nextGroup;
      setDomEditSelection(nextSelection);
      setDomEditGroupSelections(nextGroup);

      // Selecting something outside the drilled-into group exits the drill-in, so
      // a later click on the group selects it as a unit again (non-sticky drill-in).
      const activeGroup = activeGroupElementRef.current;
      if (activeGroup && nextSelection && !activeGroup.contains(nextSelection.element)) {
        activeGroupElementRef.current = null;
        setActiveGroupElementState(null);
      }

      if (nextSelection) {
        if (options?.revealPanel !== false) {
          setRightCollapsed(false);
        }
        announceTimelineSelection(nextGroup, nextSelection);
        return;
      }

      announceTimelineSelection([], null);
    },
    [announceTimelineSelection, setRightCollapsed],
  );

  const clearDomSelection = useCallback(() => {
    applyDomSelection(null, { revealPanel: false });
  }, [applyDomSelection]);

  // Drill into / out of a group. Changing scope clears the current selection so
  // the user isn't left with an out-of-scope element selected.
  const setActiveGroupElement = useCallback(
    (el: HTMLElement | null) => {
      if (activeGroupElementRef.current === el) return;
      activeGroupElementRef.current = el;
      setActiveGroupElementState(el);
      applyDomSelection(null, { revealPanel: false });
    },
    [applyDomSelection],
  );

  const buildDomSelectionFromTarget = useCallback(
    (
      target: HTMLElement,
      options?: {
        preferClipAncestor?: boolean;
        skipSourceProbe?: boolean;
        // Override the drill-in scope (used by canvas double-click to resolve the
        // child inside a group before the activeGroupElement state has re-rendered).
        activeGroupElement?: HTMLElement | null;
      },
    ) => {
      return resolveDomEditSelection(target, {
        activeCompositionPath: activeCompPath,
        isMasterView,
        preferClipAncestor: options?.preferClipAncestor,
        skipSourceProbe: options?.skipSourceProbe,
        activeGroupElement:
          options && "activeGroupElement" in options
            ? options.activeGroupElement
            : activeGroupElementRef.current,
        projectId,
      });
    },
    [activeCompPath, isMasterView, projectId],
  );

  const resolveDomSelectionFromPreviewPoint = useCallback(
    // fallow-ignore-next-line complexity
    async (
      clientX: number,
      clientY: number,
      options?: {
        preferClipAncestor?: boolean;
        skipSourceProbe?: boolean;
        activeGroupElement?: HTMLElement | null;
      },
    ) => {
      const iframe = previewIframeRef.current;
      if (!iframe || captionEditMode) return null;
      try {
        if (iframe.contentDocument) reapplyPositionEditsAfterSeek(iframe.contentDocument);
      } catch {
        /* cross-origin guard */
      }
      const target = getPreviewTargetFromPointer(iframe, clientX, clientY, activeCompPath);
      if (!target) return null;
      return buildDomSelectionFromTarget(
        target,
        options && "activeGroupElement" in options
          ? {
              preferClipAncestor: options.preferClipAncestor,
              skipSourceProbe: options.skipSourceProbe,
              activeGroupElement: options.activeGroupElement,
            }
          : {
              preferClipAncestor: options?.preferClipAncestor,
              skipSourceProbe: options?.skipSourceProbe,
            },
      );
    },
    [activeCompPath, buildDomSelectionFromTarget, captionEditMode, previewIframeRef],
  );

  const resolveAllDomSelectionsFromPreviewPoint = useCallback(
    // fallow-ignore-next-line complexity
    async (clientX: number, clientY: number): Promise<DomEditSelection[]> => {
      const iframe = previewIframeRef.current;
      if (!iframe || captionEditMode) return [];
      try {
        if (iframe.contentDocument) reapplyPositionEditsAfterSeek(iframe.contentDocument);
      } catch {
        /* cross-origin guard */
      }
      const targets = getAllPreviewTargetsFromPointer(iframe, clientX, clientY, activeCompPath);
      const results: DomEditSelection[] = [];
      for (const target of targets) {
        const sel = await buildDomSelectionFromTarget(target, { skipSourceProbe: true });
        if (sel) results.push(sel);
      }
      return results;
    },
    [activeCompPath, buildDomSelectionFromTarget, captionEditMode, previewIframeRef],
  );

  const updateDomEditHoverSelection = useCallback((selection: DomEditSelection | null) => {
    if (domEditSelectionsTargetSame(domEditHoverSelectionRef.current, selection)) return;
    domEditHoverSelectionRef.current = selection;
    setDomEditHoverSelection(selection);
  }, []);

  const buildDomSelectionForTimelineElement = useCallback(
    // fallow-ignore-next-line complexity
    async (element: TimelineElement): Promise<DomEditSelection | null> => {
      const iframe = previewIframeRef.current;
      let doc: Document | null = null;
      try {
        doc = iframe?.contentDocument ?? null;
      } catch {
        return null;
      }
      if (!doc) return null;

      reapplyPositionEditsAfterSeek(doc);

      const targetElement = findElementForTimelineElement(doc, element, {
        activeCompositionPath: activeCompPath,
        compIdToSrc,
        isMasterView,
      });
      return targetElement
        ? buildDomSelectionFromTarget(targetElement, {
            preferClipAncestor: false,
          })
        : null;
    },
    [activeCompPath, buildDomSelectionFromTarget, compIdToSrc, isMasterView, previewIframeRef],
  );

  const handleTimelineElementSelect = useCallback(
    async (element: TimelineElement | null) => {
      const seq = ++timelineSelectSeqRef.current;
      if (!element) {
        applyDomSelection(null, { revealPanel: false });
        return;
      }

      const selection = await buildDomSelectionForTimelineElement(element);
      // A newer selection superseded this one while we were resolving — drop the stale result.
      if (seq !== timelineSelectSeqRef.current) return;
      if (selection) {
        applyDomSelection(selection);
        return;
      }
      // No canvas node (audio, a comp that is not the active one). Leaving the
      // previous selection pointed the canvas at something the user did not pick,
      // and Delete acts on the canvas first — so it removed that, not the clip.
      applyDomSelection(null, { revealPanel: false, announce: false });
    },
    [applyDomSelection, buildDomSelectionForTimelineElement],
  );

  // Forward handle to the group refresher defined below: the single-selection
  // refresher falls back to it when the primary is gone, and a ref keeps that from
  // forcing either callback to be declared in the other's dependency list.
  const refreshDomEditGroupSelectionsFromPreviewRef = useRef<
    (selections: DomEditSelection[]) => Promise<void>
  >(async () => {});

  const beginSelectionRefresh = useCallback(() => {
    const sequence = ++refreshSequenceRef.current;
    const iframe = previewIframeRef.current;
    let doc: Document | null;
    try {
      doc = iframe?.contentDocument ?? null;
    } catch {
      return null;
    }
    if (!doc) return null;
    const selection = domEditSelectionRef.current;
    const group = domEditGroupSelectionsRef.current;
    const isCurrent = () => {
      if (
        !refreshMountedRef.current || sequence !== refreshSequenceRef.current ||
        refreshScopeRef.current.projectId !== projectId ||
        refreshScopeRef.current.activeCompPath !== activeCompPath ||
        domEditSelectionRef.current !== selection ||
        domEditGroupSelectionsRef.current !== group || previewIframeRef.current !== iframe
      ) {
        return false;
      }
      try {
        return iframe?.contentDocument === doc;
      } catch {
        return false;
      }
    };
    return isCurrent() ? { doc, isCurrent } : null;
  }, [activeCompPath, previewIframeRef, projectId]);

  const refreshDomEditSelectionFromPreview = useCallback(
    // fallow-ignore-next-line complexity
    async (selection: DomEditSelection) => {
      // A save may finish after another clip was selected, before this refresh
      // even starts. Match the requested target rather than its DOM node so a
      // legitimate reload can still refresh a recreated node for the same clip.
      if (!domEditSelectionsTargetSame(selection, domEditSelectionRef.current)) return;
      const refresh = beginSelectionRefresh();
      if (!refresh) return;
      const { doc, isCurrent } = refresh;

      const element = findElementForSelection(doc, selection, activeCompPath);
      if (!element) {
        // Losing the primary is not losing the selection. When a group is live,
        // re-resolve it and keep whoever still exists rather than wiping the lot.
        const group = domEditGroupSelectionsRef.current;
        logSelect("refresh-lost", {
          target: selection.selector ?? selection.id ?? null,
          group: group.length,
        });
        if (group.length > 1) {
          await refreshDomEditGroupSelectionsFromPreviewRef.current(group);
          return;
        }
        applyDomSelection(null, { revealPanel: false });
        return;
      }

      const nextSelection = await buildDomSelectionFromTarget(element);
      if (!isCurrent() || !element.isConnected) return;
      if (nextSelection) {
        applyDomSelection(nextSelection, {
          revealPanel: false,
          preserveGroup: true,
        });
      }
    },
    [activeCompPath, applyDomSelection, beginSelectionRefresh, buildDomSelectionFromTarget],
  );

  const refreshDomEditGroupSelectionsFromPreview = useCallback(
    // fallow-ignore-next-line complexity
    async (selections: DomEditSelection[]) => {
      const currentGroup = domEditGroupSelectionsRef.current;
      if (
        selections.length !== currentGroup.length ||
        selections.some(selection => !domEditSelectionInGroup(currentGroup, selection)) ||
        currentGroup.some(selection => !domEditSelectionInGroup(selections, selection))
      ) return;
      const refresh = beginSelectionRefresh();
      if (!refresh) return;
      const { doc, isCurrent } = refresh;

      const nextGroup: DomEditSelection[] = [];
      for (const selection of selections) {
        const element = findElementForSelection(doc, selection, activeCompPath);
        if (!element) continue;
        const nextSelection = await buildDomSelectionFromTarget(element);
        if (!isCurrent() || !element.isConnected) return;
        if (nextSelection) nextGroup.push(nextSelection);
      }
      if (nextGroup.length === 0 || nextGroup.some(selection => !selection.element.isConnected)) return;

      const currentSelection = domEditSelectionRef.current;
      const nextSelection =
        nextGroup.find((selection) => domEditSelectionsTargetSame(selection, currentSelection)) ??
        nextGroup[0] ??
        null;

      domEditSelectionRef.current = nextSelection;
      domEditGroupSelectionsRef.current = nextGroup;
      setDomEditSelection(nextSelection);
      setDomEditGroupSelections(nextGroup);

      announceTimelineSelection(nextGroup, nextSelection);
    },
    [activeCompPath, announceTimelineSelection, beginSelectionRefresh, buildDomSelectionFromTarget],
  );

  // ── Effects ──

  useEffect(() => {
    refreshDomEditGroupSelectionsFromPreviewRef.current = refreshDomEditGroupSelectionsFromPreview;
  }, [refreshDomEditGroupSelectionsFromPreview]);

  // Clear hover unconditionally on composition/project/preview change
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    updateDomEditHoverSelection(null);
  }, [activeCompPath, projectId, previewIframe, refreshKey, updateDomEditHoverSelection]);

  // Clear committed selection only when the composition identity actually changes.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const previous = compositionIdentityRef.current;
    if (previous.activeCompPath === activeCompPath && previous.projectId === projectId) return;
    compositionIdentityRef.current = { activeCompPath, projectId };
    activeGroupElementRef.current = null;
    setActiveGroupElementState(null);
    applyDomSelection(null, { revealPanel: false });
  }, [activeCompPath, projectId, applyDomSelection]);

  // Clear hover conditionally (caption mode, matches selection, disconnected element)
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!domEditHoverSelection) return;
    const shouldClear =
      captionEditMode ||
      domEditSelectionsTargetSame(domEditHoverSelection, domEditSelection) ||
      domEditSelectionInGroup(domEditGroupSelections, domEditHoverSelection) ||
      !domEditHoverSelection.element.isConnected;
    if (shouldClear) updateDomEditHoverSelection(null);
  }, [
    captionEditMode,
    domEditHoverSelection,
    domEditSelection,
    domEditGroupSelections,
    updateDomEditHoverSelection,
  ]);

  // Clear selection on caption mode change
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!captionEditMode) return;
    applyDomSelection(null, { revealPanel: false });
  }, [applyDomSelection, captionEditMode]);

  // Dev-only headless-QA shortcut (window.__studioTest.selectByDomId). No-op in prod.
  useStudioTestHooks({ previewIframeRef, buildDomSelectionFromTarget, applyDomSelection });

  const applyMarqueeSelection = useCallback(
    // fallow-ignore-next-line complexity
    (selections: DomEditSelection[], additive: boolean) => {
      logSelect("marquee", { hits: selections.length, additive });
      if (selections.length === 0) {
        if (!additive) applyDomSelection(null, { revealPanel: false });
        return;
      }
      const current = domEditSelectionRef.current;
      const currentGroup = domEditGroupSelectionsRef.current;
      let nextGroup: DomEditSelection[];
      if (additive) {
        nextGroup = seedDomEditGroupWithSelection(currentGroup, current);
        for (const s of selections) {
          if (!domEditSelectionInGroup(nextGroup, s)) nextGroup = [...nextGroup, s];
        }
      } else {
        // Dedupe by target: select-as-unit collapses marquee'd members to one group.
        nextGroup = [];
        for (const s of selections) {
          if (!domEditSelectionInGroup(nextGroup, s)) nextGroup.push(s);
        }
      }
      const nextSelection = additive && current ? current : selections[0];
      domEditSelectionRef.current = nextSelection;
      domEditGroupSelectionsRef.current = nextGroup;
      setDomEditSelection(nextSelection);
      setDomEditGroupSelections(nextGroup);
      announceTimelineSelection(nextGroup, nextSelection);
    },
    [applyDomSelection, announceTimelineSelection],
  );

  return {
    // State
    domEditSelection,
    domEditGroupSelections,
    domEditHoverSelection,
    activeGroupElement,
    // Refs
    domEditSelectionRef,
    domEditGroupSelectionsRef,
    domEditHoverSelectionRef,
    activeGroupElementRef,
    // State setters
    setDomEditSelection,
    setDomEditGroupSelections,
    setActiveGroupElement,
    // Callbacks
    applyDomSelection,
    clearDomSelection,
    buildDomSelectionFromTarget,
    resolveDomSelectionFromPreviewPoint,
    resolveAllDomSelectionsFromPreviewPoint,
    updateDomEditHoverSelection,
    buildDomSelectionForTimelineElement,
    handleTimelineElementSelect,
    refreshDomEditSelectionFromPreview,
    refreshDomEditGroupSelectionsFromPreview,
    applyMarqueeSelection,
  };
}
