import { desktopRequest } from "../../lib/desktopClient";
import { useEffect, useRef } from "react";
import { useCaptionStore } from "../store";
import { acceptStudioRuntimeMessage } from "../../player/lib/runtimeProtocol";
import { useCaptionSync } from "./useCaptionSync";
import { parseCaptionComposition } from "../parser";

interface UseCaptionDetectionParams {
  projectId: string | null;
  activeCompPath: string | null;
  compIdToSrc: Map<string, string>;
  captionEditMode: boolean;
  captionHasSelection: boolean;
  previewIframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
  captionSync: ReturnType<typeof useCaptionSync>;
  setRightCollapsed: (collapsed: boolean) => void;
}

export function useCaptionDetection({
  projectId,
  activeCompPath,
  compIdToSrc,
  captionEditMode,
  captionHasSelection,
  previewIframeRef,
  captionSync,
  setRightCollapsed,
}: UseCaptionDetectionParams) {
  // Switching compositions must drop the previous comp's caption state — a
  // stale model + full-canvas overlay otherwise blocks normal element editing
  // on the new composition (and edit mode could never be exited).
  const scope = JSON.stringify([projectId, activeCompPath]);
  const currentScopeRef = useRef(scope);
  currentScopeRef.current = scope;
  const prevCompPathRef = useRef(scope);
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (prevCompPathRef.current !== scope) {
      prevCompPathRef.current = scope;
      const store = useCaptionStore.getState();
      if (store.model || store.isEditMode) {
        // Flush the last debounced caption edit before the reset destroys the
        // model — otherwise a save landing after the switch writes nothing.
        store.retrySave?.();
        store.reset();
      }
    }
  }, [scope]);

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!projectId) return;

    let activating = false;
    let cancelled = false;

    const tryActivateCaptions = () => {
      const captionState = useCaptionStore.getState();
      // `dismissed` = user explicitly exited caption editing; don't re-trap them.
      if (captionState.isEditMode || captionState.dismissed || activating) {
        return;
      }

      const iframe = previewIframeRef.current;
      let doc: Document | null = null;
      let win: Window | null = null;
      try {
        doc = iframe?.contentDocument ?? null;
        win = iframe?.contentWindow ?? null;
      } catch {
        return;
      }
      if (!doc || !win) return;

      const groups = doc.querySelectorAll(".caption-group");
      if (groups.length === 0) return;

      let captionSrcPath: string | null = null;

      const compHosts = doc.querySelectorAll("[data-composition-src], [data-composition-file]");
      for (const host of compHosts) {
        const src =
          host.getAttribute("data-composition-src") || host.getAttribute("data-composition-file");
        if (src && src.includes("captions")) {
          captionSrcPath = src;
          break;
        }
      }

      if (!captionSrcPath) {
        for (const [id, src] of compIdToSrc) {
          if (id.includes("caption") || src.includes("caption")) {
            captionSrcPath = src;
            break;
          }
        }
      }

      if (!captionSrcPath && activeCompPath?.includes("captions")) {
        captionSrcPath = activeCompPath;
      }

      if (!captionSrcPath) {
        const captionComp = doc.querySelector('[data-composition-id*="caption"]');
        if (captionComp) {
          const compId = captionComp.getAttribute("data-composition-id") || "";
          captionSrcPath = compIdToSrc.get(compId) || null;
        }
      }

      if (!captionSrcPath) return;

      activating = true;
      const srcPath = captionSrcPath;
      desktopRequest(`/api/projects/${projectId}/files/${encodeURIComponent(srcPath)}`)
        .then((r) => { if (!r.ok) throw new Error(`Could not read captions (${r.status})`); return r.json(); })
        .then((data: { content?: string }) => {
          if (cancelled || currentScopeRef.current !== scope || previewIframeRef.current?.contentDocument !== doc ||
            !data.content || !doc || !win || useCaptionStore.getState().isEditMode || useCaptionStore.getState().dismissed) return;
          const root = doc.querySelector("[data-composition-id]");
          const w = parseInt(root?.getAttribute("data-width") ?? "1920", 10);
          const h = parseInt(root?.getAttribute("data-height") ?? "1080", 10);
          const dur = parseFloat(root?.getAttribute("data-duration") ?? "0");
          const model = parseCaptionComposition(doc, win, data.content, w, h, dur);
          if (!model) return;
          const store = useCaptionStore.getState();
          store.setModel(model);
          store.setSourceFilePath(srcPath);
          store.setEditMode(true);
          captionSync.loadOverrides();
        })
        .catch(() => {})
        .finally(() => {
          activating = false;
        });
    };

    const handleMessage = (e: MessageEvent) => {
      const data = e.data;
      if (data?.source === "hf-preview" && (data?.type === "state" || data?.type === "timeline")) {
        if (!acceptStudioRuntimeMessage(data)) return;
        tryActivateCaptions();
      }
    };

    window.addEventListener("message", handleMessage);
    tryActivateCaptions();

    return () => {
      cancelled = true;
      window.removeEventListener("message", handleMessage);
    };
  }, [activeCompPath, projectId, compIdToSrc, captionSync.loadOverrides, previewIframeRef, scope]);

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (captionEditMode) {
      setRightCollapsed(!captionHasSelection);
    }
  }, [captionHasSelection, captionEditMode, setRightCollapsed]);
}
