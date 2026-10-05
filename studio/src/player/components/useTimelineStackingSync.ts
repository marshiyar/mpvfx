import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { TimelineElement } from "../store/playerStore";
import { usePlayerStore } from "../store/playerStore";
import { useDomEditActionsContextOptional } from "../../features/canvas/DomEditContext";
import { useStudioShellContextOptional } from "../../app/StudioContext";
import { previewAgentForIframe } from "../../features/preview/previewAgentClient";
import { previewOriginFromIframe } from "../lib/previewUrl";
import { previewOriginForProject } from "../../../shared/desktopPreviewOrigin";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import { findElementForSelection } from "../../features/canvas/domEditingElement";
import { readEffectiveZIndex } from "../../features/canvas/canvasContextMenuZOrder";
import type { StackingPatch } from "./timelineStackingSync";

interface UseTimelineStackingSyncInput {
  expandedElementsRef: RefObject<TimelineElement[]>;
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
}: UseTimelineStackingSyncInput) {
  const domEditActions = useDomEditActionsContextOptional();
  const shell = useStudioShellContextOptional();
  const zSyncPreviewIframeRef = domEditActions?.previewIframeRef ?? null;
  const handleDomZIndexReorderCommit = domEditActions?.handleDomZIndexReorderCommit;
  const commitRemoteStackingPatches = domEditActions?.commitRemoteStackingPatches;
  const zSyncActiveCompPath = shell?.activeCompPath ?? null;
  const remoteStatesRef = useRef<PreviewElementState[]>([]);

  const isolatedIframe = useCallback(() => {
    const iframe = zSyncPreviewIframeRef?.current;
    if (!iframe || !shell?.projectId ||
        previewOriginFromIframe(iframe) !== previewOriginForProject(shell.projectId)) return null;
    try { if (iframe.contentDocument) return null; } catch { /* Isolated preview. */ }
    return iframe;
  }, [zSyncPreviewIframeRef, shell?.projectId]);

  const readRemoteStates = useCallback(async (iframe: HTMLIFrameElement): Promise<PreviewElementState[]> => {
    const client = previewAgentForIframe(iframe);
    if (!client?.isReady) return [];
    const states: PreviewElementState[] = [];
    for (let offset = 0; offset < 3000; offset += 300) {
      const page = await client.request({ kind: "snapshot", offset, limit: 300 });
      if (!Array.isArray(page)) return [];
      states.push(...page);
      if (page.length < 300) break;
    }
    return isolatedIframe() === iframe && client.isReady ? states : [];
  }, [isolatedIframe]);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let generation = 0;
    const attach = () => {
      unsubscribe?.();
      remoteStatesRef.current = [];
      const iframe = isolatedIframe();
      const client = iframe && previewAgentForIframe(iframe);
      const currentGeneration = ++generation;
      unsubscribe = client?.onReady(() => {
        if (!iframe) return;
        void readRemoteStates(iframe).then(states => {
          if (generation === currentGeneration) remoteStatesRef.current = states;
        }).catch(() => {});
      }) ?? null;
    };
    const onAttached = (event: Event) => {
      if ((event as CustomEvent<HTMLIFrameElement>).detail === zSyncPreviewIframeRef?.current) attach();
    };
    window.addEventListener("mpvfx-preview-agent-attached", onAttached);
    const iframe = zSyncPreviewIframeRef?.current;
    iframe?.addEventListener("load", attach);
    attach();
    return () => {
      generation++;
      unsubscribe?.();
      iframe?.removeEventListener("load", attach);
      window.removeEventListener("mpvfx-preview-agent-attached", onAttached);
    };
  }, [isolatedIframe, readRemoteStates, zSyncPreviewIframeRef]);

  const remoteStateFor = useCallback((el: TimelineElement, states: readonly PreviewElementState[]) => {
    const sourceFile = el.sourceFile ?? zSyncActiveCompPath ?? "index.html";
    const matches = states.filter(state => state.sourceFile === sourceFile && state.tag === el.tag.toLowerCase() &&
      (el.hfId ? state.dataAttributes["hf-id"] === el.hfId : state.id === (el.domId ?? el.id)) &&
      Boolean(state.dataAttributes["studio-clip-id"]));
    return matches.length === 1 ? matches[0] : null;
  }, [zSyncActiveCompPath]);

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
      if (isolatedIframe()) {
        const state = remoteStateFor(el, remoteStatesRef.current);
        if (!state) return el.hasExplicitZIndex && Number.isFinite(el.zIndex)
          ? el.zIndex! : Number.NaN;
        const raw = state.inlineStyles["z-index"] || state.computedStyles["z-index"];
        if (!raw || raw === "auto") return 0;
        const z = Number(raw);
        return Number.isFinite(z) ? z : Number.NaN;
      }
      const node = resolveIframeElement(el);
      return node ? readEffectiveZIndex(node) : Number.NaN;
    },
    [isolatedIframe, remoteStateFor, resolveIframeElement],
  );

  const applyStackingPatches = useCallback(
    async (patches: StackingPatch[], coalesceKey?: string) => {
      const iframe = isolatedIframe();
      if (iframe) {
        if (!commitRemoteStackingPatches) return;
        const states = await readRemoteStates(iframe);
        if (states.length === 0) return;
        const entries = patches.map(patch => {
          const element = expandedElementsRef.current.find(el => (el.key ?? el.id) === patch.key);
          const state = element && remoteStateFor(element, states);
          if (!state) throw new Error("A reordered clip is not uniquely available in the preview");
          return { state, zIndex: patch.zIndex };
        });
        if (await commitRemoteStackingPatches(entries, coalesceKey)) {
          for (const patch of patches) {
            usePlayerStore.getState().updateElement(patch.key, { zIndex: patch.zIndex, hasExplicitZIndex: true });
          }
          usePlayerStore.getState().bumpZEditVersion();
        }
        return;
      }
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
      if (entries.length) await handleDomZIndexReorderCommit(entries, coalesceKey);
    },
    [commitRemoteStackingPatches, handleDomZIndexReorderCommit, isolatedIframe,
      readRemoteStates, remoteStateFor, resolveIframeElement, zSyncActiveCompPath, expandedElementsRef],
  );

  // Engage the z-sync only when the persist path is present (inside the NLE).
  const zSyncEnabled = Boolean(zSyncPreviewIframeRef && (isolatedIframe()
    ? commitRemoteStackingPatches : handleDomZIndexReorderCommit));

  // Stacking is authored state. Only explicit lane/layer commands apply patches;
  // opening, timing changes and history reloads must never create a new edit.

  return { readClipZIndex, applyStackingPatches, zSyncEnabled };
}
