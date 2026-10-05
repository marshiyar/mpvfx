import { useEffect, useRef, useState, type RefObject } from "react";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import { usePlayerStore } from "../../player/index";
import { findMatchingTimelineElementId } from "../../lib/studioHelpers";
import { useDomEditActionsContext, useDomEditSelectionContext } from "./DomEditContext";
import { commitRemoteNativeMove, remoteNativeClipId, resolveRemoteNativeClip } from "./remoteNativePreviewEdit";
import { previewAgentForIframe, previewRectToClient } from "../preview/previewAgentClient";

interface Props {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  enabled: boolean;
}

/** Handle-based native canvas selection for an isolated preview frame. */
export function IsolatedPreviewOverlay({ iframeRef, enabled }: Props) {
  const { nativeProjectDocument } = useDomEditSelectionContext();
  const { commitNativeProject } = useDomEditActionsContext();
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<PreviewElementState | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; pointerId: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    let attachedFrame: HTMLIFrameElement | null = null;
    let attachedClient = previewAgentForIframe(null);
    let unsubscribe: (() => void) | undefined;
    const attach = (candidate?: HTMLIFrameElement) => {
      // The NLE player's callback ref attaches its agent before the outer App
      // ref is notified on iframe load. Use that event's exact frame during
      // the handoff; the App ref catches up before the agent becomes ready.
      const frame = candidate ?? iframeRef.current;
      if (!frame) return;
      const client = previewAgentForIframe(frame);
      if (frame === attachedFrame && client === attachedClient) return;
      unsubscribe?.();
      attachedFrame?.removeEventListener("load", onLoad);
      attachedFrame = frame;
      attachedClient = client;
      setReady(Boolean(client?.isReady));
      unsubscribe = client?.onReady(() => setReady(true));
      frame.addEventListener("load", onLoad);
    };
    const onLoad = () => {
      requestSeq.current++;
      setSelected(null);
      setReady(false);
    };
    const onAgentAttached = (event: Event) => {
      const frame = (event as CustomEvent<unknown>).detail;
      if (frame instanceof HTMLIFrameElement) attach(frame);
    };
    attach();
    window.addEventListener("mpvfx-preview-agent-attached", onAgentAttached);
    return () => {
      unsubscribe?.();
      attachedFrame?.removeEventListener("load", onLoad);
      window.removeEventListener("mpvfx-preview-agent-attached", onAgentAttached);
    };
  }, [iframeRef, enabled]);

  const frame = iframeRef.current;
  let isolated = false;
  try { isolated = Boolean(frame && !frame.contentDocument); } catch { isolated = true; }
  if (!enabled || !ready || !isolated || !frame) return null;

  const viewportBox = selected ? previewRectToClient(frame, selected.rect) : null;
  const overlayBox = overlayRef.current?.getBoundingClientRect();
  const selectionStyle = viewportBox && overlayBox ? {
    left: viewportBox.x - overlayBox.left + (drag?.x ?? 0),
    top: viewportBox.y - overlayBox.top + (drag?.y ?? 0),
    width: viewportBox.width,
    height: viewportBox.height,
  } : undefined;

  return <div ref={overlayRef} className="absolute inset-0 z-20" aria-label="Isolated composition canvas"
    onPointerDown={event => {
      if (event.button !== 0 || event.target !== event.currentTarget) return;
      const client = previewAgentForIframe(frame);
      if (!client) return;
      const seq = ++requestSeq.current;
      void client.hitTestAtClientPoint(event.clientX, event.clientY).then(target => {
        if (seq !== requestSeq.current || iframeRef.current !== frame) return;
        if (!target || !nativeProjectDocument || !resolveRemoteNativeClip(nativeProjectDocument, target)) {
          setSelected(null);
          return;
        }
        setSelected(target);
        const store = usePlayerStore.getState();
        const timelineId = findMatchingTimelineElementId({
          id: target.id || undefined, selector: target.selector,
          selectorIndex: target.selectorIndex, sourceFile: target.sourceFile,
          isCompositionHost: false,
        }, store.elements) ?? store.elements.find(element =>
          element.id === remoteNativeClipId(target) || element.key === remoteNativeClipId(target),
        )?.key;
        if (timelineId) store.setSelectedElementId(timelineId);
      }).catch(() => setSelected(null));
    }}>
    {selected && selectionStyle && <div
      className="absolute border-2 border-studio-accent bg-studio-accent/5 cursor-move"
      data-testid="isolated-preview-selection"
      style={selectionStyle}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ x: 0, y: 0, pointerId: event.pointerId });
        (event.currentTarget as HTMLElement).dataset.startX = String(event.clientX);
        (event.currentTarget as HTMLElement).dataset.startY = String(event.clientY);
      }}
      onPointerMove={event => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const node = event.currentTarget as HTMLElement;
        setDrag({ ...drag, x: event.clientX - Number(node.dataset.startX), y: event.clientY - Number(node.dataset.startY) });
      }}
      onPointerUp={event => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        const rect = frame.getBoundingClientRect();
        const delta = { x: drag.x * (frame.clientWidth || rect.width) / rect.width,
          y: drag.y * (frame.clientHeight || rect.height) / rect.height };
        setDrag(null);
        if (nativeProjectDocument && Number.isFinite(delta.x) && Number.isFinite(delta.y)) {
          void commitRemoteNativeMove(nativeProjectDocument, selected, delta, commitNativeProject);
        }
      }}
    />}
  </div>;
}
