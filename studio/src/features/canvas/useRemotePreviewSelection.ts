import { useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import type { DomEditSelection } from "./domEditingTypes";
import { isPreviewElementState, previewAgentForIframe } from "../preview/previewAgentClient";

interface RemotePreviewSelectionOptions {
  previewIframeRef: MutableRefObject<HTMLIFrameElement | null>;
  setDomEditSelection: Dispatch<SetStateAction<DomEditSelection | null>>;
  setDomEditGroupSelections: Dispatch<SetStateAction<DomEditSelection[]>>;
  domEditSelectionRef: MutableRefObject<DomEditSelection | null>;
  domEditGroupSelectionsRef: MutableRefObject<DomEditSelection[]>;
  setRightCollapsed: (collapsed: boolean) => void;
}

/** Isolated authored frames provide bounded data, never parent-owned elements. */
export function useRemotePreviewSelection({
  previewIframeRef, setDomEditSelection, setDomEditGroupSelections,
  domEditSelectionRef, domEditGroupSelectionsRef, setRightCollapsed,
}: RemotePreviewSelectionOptions) {
  const [remoteSelection, setRemoteSelection] = useState<PreviewElementState | null>(null);
  useEffect(() => {
    let request = 0;
    const onSelection = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      const { iframe, state } = detail as { iframe?: unknown; state?: unknown };
      if (!(iframe instanceof HTMLIFrameElement) || iframe !== previewIframeRef.current) return;
      const sequence = ++request;
      if (state === null) { setRemoteSelection(null); return; }
      if (!isPreviewElementState(state)) return;
      const client = previewAgentForIframe(iframe);
      if (!client?.isReady) return;
      void client.request({ kind: "readElement", handle: state.handle }).then(fresh => {
        if (sequence !== request || iframe !== previewIframeRef.current ||
            !fresh || Array.isArray(fresh) || fresh.handle !== state.handle) return;
        // Announcing an empty legacy selection here would erase the timeline
        // anchor that selected this remote handle.
        domEditSelectionRef.current = null;
        domEditGroupSelectionsRef.current = [];
        setDomEditSelection(null);
        setDomEditGroupSelections([]);
        setRemoteSelection(fresh);
        setRightCollapsed(false);
      }).catch(() => {
        if (sequence === request) setRemoteSelection(null);
      });
    };
    const onLoad = () => { request++; setRemoteSelection(null); };
    let frame: HTMLIFrameElement | null = null;
    const attach = (candidate: HTMLIFrameElement | null) => {
      if (candidate === frame) return;
      frame?.removeEventListener("load", onLoad);
      frame = candidate;
      frame?.addEventListener("load", onLoad);
      onLoad();
    };
    const onAgentAttached = (event: Event) => {
      const candidate = (event as CustomEvent<unknown>).detail;
      if (candidate instanceof HTMLIFrameElement) attach(candidate);
    };
    attach(previewIframeRef.current);
    window.addEventListener("mpvfx-isolated-preview-selection", onSelection);
    window.addEventListener("mpvfx-preview-agent-attached", onAgentAttached);
    return () => {
      request++;
      frame?.removeEventListener("load", onLoad);
      window.removeEventListener("mpvfx-isolated-preview-selection", onSelection);
      window.removeEventListener("mpvfx-preview-agent-attached", onAgentAttached);
    };
  }, [previewIframeRef, setRightCollapsed, domEditSelectionRef, domEditGroupSelectionsRef,
    setDomEditSelection, setDomEditGroupSelections]);
  return { remoteSelection, setRemoteSelection };
}
