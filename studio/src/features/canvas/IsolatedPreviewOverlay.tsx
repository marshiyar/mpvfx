import { useEffect, useRef, useState, type RefObject } from "react";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import { usePlayerStore } from "../../player/index";
import { findMatchingTimelineElementId } from "../../lib/studioHelpers";
import { useStudioShellContext } from "../../app/StudioContext";
import { useDomEditActionsContext } from "./DomEditContext";
import { commitRemoteNativeGroupMove, commitRemoteNativeResize, commitRemoteNativeRotation,
  remoteLegacySelectionTargets, remoteNativeClipId, remoteNativeMarqueeTargets,
  remoteNativeResizeBaseline, remoteNativeResizeReady,
  resolveRemoteNativeClip } from "./remoteNativePreviewEdit";
import { clientPointToPreview, previewAgentForIframe, previewRectToClient } from "../preview/previewAgentClient";
import { IsolatedPreviewCropHandles } from "./IsolatedPreviewCropHandles";

interface Props {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  enabled: boolean;
}

type Gesture = { mode: "move" | "resize" | "rotate"; pointerId: number;
  startX: number; startY: number; x: number; y: number; angle: number };
type Marquee = { pointerId: number; startX: number; startY: number; x: number; y: number;
  extend: boolean };
type PendingRevision = { revision: number; resize?: { handle: string; width: number; height: number } };

function angleAt(x: number, y: number, center: { x: number; y: number }): number {
  return Math.atan2(y - center.y, x - center.x) * 180 / Math.PI;
}

/** Handle-based native canvas selection for an isolated preview frame. */
export function IsolatedPreviewOverlay({ iframeRef, enabled }: Props) {
  const { activeCompPath } = useStudioShellContext();
  const { commitNativeProject, commitRemoteInspectorEdit, nativeDocument } = useDomEditActionsContext();
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<PreviewElementState | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<PreviewElementState[]>([]);
  const [drag, setDrag] = useState<Gesture | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [pendingRevision, setPendingRevision] = useState<PendingRevision | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);

  const publishSelection = (frame: HTMLIFrameElement, state: PreviewElementState | null) => {
    setSelected(state);
    if (!state) setSelectedGroup([]);
    window.dispatchEvent(new CustomEvent("mpvfx-isolated-preview-selection", {
      detail: { iframe: frame, state },
    }));
  };

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
      if (attachedFrame) publishSelection(attachedFrame, null);
      setMarquee(null);
      gestureRef.current = null;
      setDrag(null);
      setPendingRevision(null);
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

  useEffect(() => {
    const handle = selected?.handle;
    const frame = iframeRef.current;
    if (!enabled || !handle || !frame) return;
    let cancelled = false;
    let busy = false;
    const refresh = async () => {
      if (busy || cancelled) return;
      const client = previewAgentForIframe(frame);
      if (!client?.isReady) return;
      busy = true;
      try {
        const state = await client.request({ kind: "readElement", handle });
        if (cancelled || !state || Array.isArray(state)) return;
        setSelected(previous => previous?.handle === handle &&
          (previous.rect.x !== state.rect.x || previous.rect.y !== state.rect.y ||
            previous.rect.width !== state.rect.width || previous.rect.height !== state.rect.height ||
            previous.computedStyles.width !== state.computedStyles.width ||
            previous.computedStyles.height !== state.computedStyles.height)
          ? state : previous);
        setSelectedGroup(previous => {
          const index = previous.findIndex(item => item.handle === handle);
          if (index < 0) return previous;
          const old = previous[index]!;
          if (old.rect.x === state.rect.x && old.rect.y === state.rect.y &&
            old.rect.width === state.rect.width && old.rect.height === state.rect.height) return previous;
          return previous.map(item => item.handle === handle ? state : item);
        });
      } catch { /* A navigation revokes the handle and its load listener clears selection. */ }
      finally { busy = false; }
    };
    const timer = setInterval(() => { void refresh(); }, 100);
    return () => { cancelled = true; clearInterval(timer); };
  }, [enabled, iframeRef, selected?.handle]);

  useEffect(() => {
    if (pendingRevision !== null && nativeDocument?.revision !== undefined &&
      nativeDocument.revision >= pendingRevision.revision &&
      (!pendingRevision.resize || (selected?.handle === pendingRevision.resize.handle &&
        remoteNativeResizeReady(selected, pendingRevision.resize)))) setPendingRevision(null);
  }, [nativeDocument?.revision, pendingRevision, selected]);

  const frame = iframeRef.current;
  let isolated = false;
  try { isolated = Boolean(frame && !frame.contentDocument); } catch { isolated = true; }
  if (!enabled || !ready || !isolated || !frame) return null;

  const viewportBox = selected ? previewRectToClient(frame, selected.rect) : null;
  const overlayBox = overlayRef.current?.getBoundingClientRect();
  const selectionStyle = viewportBox && overlayBox ? {
    left: viewportBox.x - overlayBox.left + (drag?.mode === "move" ? drag.x : 0),
    top: viewportBox.y - overlayBox.top + (drag?.mode === "move" ? drag.y : 0),
    width: Math.max(1, viewportBox.width + (drag?.mode === "resize" ? drag.x : 0)),
    height: Math.max(1, viewportBox.height + (drag?.mode === "resize" ? drag.y : 0)),
  } : undefined;
  const resizeBaseline = selected ? remoteNativeResizeBaseline(selected) : null;
  const nativeSelected = Boolean(selected && nativeDocument &&
    resolveRemoteNativeClip(nativeDocument, selected));
  const crop = selected?.computedStyles["clip-path"] ?? selected?.inlineStyles["clip-path"];
  const canRotate = !crop || crop === "none";
  const waitingForRevision = pendingRevision !== null;

  const timelineIdFor = (target: PreviewElementState): string | null => {
    const store = usePlayerStore.getState();
    return findMatchingTimelineElementId({
      id: target.id || undefined, selector: target.selector,
      selectorIndex: target.selectorIndex, sourceFile: target.sourceFile,
      isCompositionHost: false,
    }, store.elements) ?? store.elements.find(element =>
      element.id === remoteNativeClipId(target) || element.key === remoteNativeClipId(target),
    )?.key ?? null;
  };
  const applyTargets = (targets: PreviewElementState[], extend: boolean) => {
    const valid = targets.filter(target => nativeDocument &&
      resolveRemoteNativeClip(nativeDocument, target));
    const group = extend ? [...selectedGroup] : [];
    for (const target of valid) {
      if (!group.some(item => remoteNativeClipId(item) === remoteNativeClipId(target))) group.push(target);
    }
    const ids = group.map(timelineIdFor).filter((id): id is string => Boolean(id));
    const store = usePlayerStore.getState();
    store.setSelection(ids, ids.at(-1) ?? null);
    setSelectedGroup(group);
    publishSelection(frame, group.at(-1) ?? null);
  };

  const applyLegacyTargets = (targets: PreviewElementState[], observations: PreviewElementState[], extend: boolean) => {
    const valid = remoteLegacySelectionTargets(observations, targets, activeCompPath ?? "index.html");
    const group = extend ? [...selectedGroup] : [];
    for (const target of valid) {
      if (!group.some(item => item.handle === target.handle)) group.push(target);
    }
    usePlayerStore.getState().setSelection([], null);
    setSelectedGroup(group);
    publishSelection(frame, group.at(-1) ?? null);
  };

  const readSnapshot = async (client: NonNullable<ReturnType<typeof previewAgentForIframe>>) => {
    const observations: PreviewElementState[] = [];
    for (let offset = 0; offset <= 2400; offset += 300) {
      const page = await client.request({ kind: "snapshot", offset, limit: 300 });
      if (!Array.isArray(page)) return null;
      observations.push(...page);
      if (page.length < 300) return observations;
    }
    // Unbounded/partial snapshots cannot establish unique authored identity.
    return null;
  };

  const startGesture = (event: React.PointerEvent<HTMLElement>, mode: Gesture["mode"]) => {
    if (event.button !== 0 || !nativeSelected || !viewportBox || waitingForRevision) return;
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const center = { x: viewportBox.x + viewportBox.width / 2,
      y: viewportBox.y + viewportBox.height / 2 };
    const next = { mode, pointerId: event.pointerId, startX: event.clientX,
      startY: event.clientY, x: 0, y: 0, angle: angleAt(event.clientX, event.clientY, center) };
    gestureRef.current = next;
    setDrag(next);
  };
  const updateGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = gestureRef.current;
    if (!active || active.pointerId !== event.pointerId || !viewportBox) return;
    const center = { x: viewportBox.x + viewportBox.width / 2,
      y: viewportBox.y + viewportBox.height / 2 };
    const next = { ...active, x: event.clientX - active.startX,
      y: event.clientY - active.startY,
      ...(active.mode === "rotate" ? { angle: angleAt(event.clientX, event.clientY, center) } : {}) };
    gestureRef.current = next;
    setDrag(next);
  };
  const finishGesture = (event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !selected || !nativeDocument || !viewportBox || waitingForRevision) return;
    event.stopPropagation();
    gestureRef.current = null;
    setDrag(null);
    const rect = frame.getBoundingClientRect();
    const scaleX = (frame.clientWidth || rect.width) / rect.width;
    const scaleY = (frame.clientHeight || rect.height) / rect.height;
    let pending: Promise<boolean>;
    let resizeTarget: PendingRevision["resize"];
    if (gesture.mode === "move") {
      pending = commitRemoteNativeGroupMove(nativeDocument,
        selectedGroup.length > 1 ? selectedGroup : [selected],
        { x: gesture.x * scaleX, y: gesture.y * scaleY }, commitNativeProject);
    } else if (gesture.mode === "resize") {
      if (!resizeBaseline) return;
      resizeTarget = { handle: selected.handle,
        width: resizeBaseline.width + gesture.x * scaleX,
        height: resizeBaseline.height + gesture.y * scaleY };
      pending = commitRemoteNativeResize(nativeDocument, selected,
        { width: resizeTarget.width, height: resizeTarget.height }, commitNativeProject);
    } else {
      if (!canRotate) return;
      const center = { x: viewportBox.x + viewportBox.width / 2,
        y: viewportBox.y + viewportBox.height / 2 };
      const start = angleAt(gesture.startX, gesture.startY, center);
      let delta = gesture.angle - start;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      pending = commitRemoteNativeRotation(nativeDocument, selected, delta, commitNativeProject);
    }
    setPendingRevision({ revision: nativeDocument.revision + 1, resize: resizeTarget });
    void pending.then(ok => {
      if (!ok) { setPendingRevision(null); return; }
      const client = previewAgentForIframe(frame);
      void client?.request({ kind: "readElement", handle: selected.handle }).then(next => {
        if (next && !Array.isArray(next) && iframeRef.current === frame) publishSelection(frame, next);
      }).catch(() => {});
    }).catch(() => setPendingRevision(null));
  };
  const cancelGesture = () => { gestureRef.current = null; setDrag(null); };

  return <div ref={overlayRef} className="absolute inset-0 z-20" aria-label="Isolated composition canvas"
    onPointerDown={event => {
      if (event.button !== 0 || event.target !== event.currentTarget || waitingForRevision) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setMarquee({ pointerId: event.pointerId, startX: event.clientX,
        startY: event.clientY, x: event.clientX, y: event.clientY,
        extend: event.shiftKey });
    }}
    onPointerMove={event => {
      if (marquee?.pointerId !== event.pointerId) return;
      setMarquee({ ...marquee, x: event.clientX, y: event.clientY });
    }}
    onPointerCancel={() => setMarquee(null)}
    onPointerUp={event => {
      if (marquee?.pointerId !== event.pointerId) return;
      event.stopPropagation();
      const gesture = marquee;
      setMarquee(null);
      const client = previewAgentForIframe(frame);
      if (!client) return;
      const seq = ++requestSeq.current;
      if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 5) {
        void (async () => {
          const target = await client.hitTestAtClientPoint(event.clientX, event.clientY);
          const observations = !nativeDocument && target ? await readSnapshot(client) : null;
          if (seq !== requestSeq.current || iframeRef.current !== frame) return;
          if (nativeDocument) applyTargets(target ? [target] : [], gesture.extend);
          else if (observations || !target) applyLegacyTargets(target ? [target] : [], observations ?? [], gesture.extend);
        })().catch(() => {});
        return;
      }
      const start = clientPointToPreview(frame, gesture.startX, gesture.startY);
      const end = clientPointToPreview(frame, event.clientX, event.clientY);
      if (!start || !end) return;
      const box = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
      void (async () => {
        const observations = await readSnapshot(client);
        if (!observations || seq !== requestSeq.current || iframeRef.current !== frame) return;
        const targets = observations.filter(state => state.visible && state.rect.width > 0 && state.rect.height > 0 &&
          state.rect.x < box.x + box.width && state.rect.x + state.rect.width > box.x &&
          state.rect.y < box.y + box.height && state.rect.y + state.rect.height > box.y);
        if (nativeDocument)
          applyTargets(remoteNativeMarqueeTargets(nativeDocument, targets, box), gesture.extend);
        else applyLegacyTargets(targets, observations, gesture.extend);
      })().catch(() => {});
    }}>
    {marquee && Math.hypot(marquee.x - marquee.startX, marquee.y - marquee.startY) >= 5 && overlayBox &&
      <div aria-hidden="true" className="pointer-events-none absolute border border-studio-accent bg-studio-accent/10"
        style={{ left: Math.min(marquee.x, marquee.startX) - overlayBox.left,
          top: Math.min(marquee.y, marquee.startY) - overlayBox.top,
          width: Math.abs(marquee.x - marquee.startX), height: Math.abs(marquee.y - marquee.startY) }} />}
    {selectedGroup.filter(item => item.handle !== selected?.handle).map(item => {
      const box = previewRectToClient(frame, item.rect);
      return box && overlayBox ? <div key={item.handle} aria-hidden="true"
        className="pointer-events-none absolute border-2 border-studio-accent/70"
        style={{ left: box.x - overlayBox.left + (drag?.mode === "move" ? drag.x : 0),
          top: box.y - overlayBox.top + (drag?.mode === "move" ? drag.y : 0),
          width: box.width, height: box.height }} /> : null;
    })}
    {selected && selectionStyle && <div
      className={`absolute border-2 border-studio-accent bg-studio-accent/5 ${nativeSelected ? "cursor-move" : "cursor-default"}`}
      data-testid="isolated-preview-selection"
      style={selectionStyle}
      onPointerDown={event => startGesture(event, "move")}
      onPointerMove={updateGesture}
      onPointerUp={finishGesture}
      onPointerCancel={cancelGesture}>
      {nativeSelected && <button type="button" aria-label="Rotate selected layer" data-testid="isolated-preview-rotate"
        disabled={!canRotate || waitingForRevision}
        title={!canRotate ? "Cropped rotation requires the authored pivot editor" : undefined}
        className="absolute -top-7 left-1/2 h-4 w-4 -translate-x-1/2 rounded-full border-2 border-studio-accent bg-white cursor-grab"
        onPointerDown={event => startGesture(event, "rotate")}
        onPointerMove={updateGesture} onPointerUp={finishGesture}
        onPointerCancel={cancelGesture} />}
      {nativeSelected && <button type="button" aria-label="Resize selected layer" data-testid="isolated-preview-resize"
        disabled={!resizeBaseline || waitingForRevision}
        title={!resizeBaseline ? "This layer's source box cannot be resized from the preview" : undefined}
        className="absolute -bottom-2 -right-2 h-4 w-4 border-2 border-studio-accent bg-white cursor-se-resize"
        onPointerDown={event => startGesture(event, "resize")}
        onPointerMove={updateGesture} onPointerUp={finishGesture}
        onPointerCancel={cancelGesture} />}
      {nativeSelected && nativeDocument && !waitingForRevision && <IsolatedPreviewCropHandles key={selected.handle} frame={frame} selection={selected}
        width={selectionStyle.width} height={selectionStyle.height}
        commit={commitRemoteInspectorEdit} />}
    </div>}
  </div>;
}
