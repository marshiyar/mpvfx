import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import { buildInsetClipPathSides, type ClipPathInsetSides } from "../inspector/clipPathHelpers";
import { previewAgentForIframe } from "../preview/previewAgentClient";
import { resolveCropInsetFromEdgeDrag, type CropEdge } from "./domEditOverlayCrop";
import { remoteNativeCropBaseline } from "./remoteNativePreviewEdit";

interface Props {
  frame: HTMLIFrameElement;
  selection: PreviewElementState;
  width: number;
  height: number;
  commit: (selection: PreviewElementState, operations: [{ type: "inline-style";
    property: "clip-path"; value: string | null }], label: string) => Promise<boolean>;
}

type CropGesture = { edge: CropEdge; pointerId: number; x: number; y: number;
  original: ClipPathInsetSides; current: ClipPathInsetSides };

function cssCrop(insets: ClipPathInsetSides): string {
  return Object.values(insets).some(value => value > 0)
    ? buildInsetClipPathSides(insets, 0) : "none";
}

/** Crop edits are preview drafts until a source-bound transaction succeeds. */
export function IsolatedPreviewCropHandles({ frame, selection, width, height, commit }: Props) {
  const baseline = remoteNativeCropBaseline(selection);
  const [enabled, setEnabled] = useState(false);
  const [draft, setDraft] = useState<ClipPathInsetSides | null>(null);
  const gesture = useRef<CropGesture | null>(null);
  const generation = useRef(0);
  if (!baseline || (selection.tag !== "video" && selection.tag !== "img")) return null;
  const current = draft ?? baseline.insets;
  const sx = width / baseline.box.width;
  const sy = height / baseline.box.height;

  const preview = (insets: ClipPathInsetSides) => {
    const client = previewAgentForIframe(frame);
    if (!client) return;
    const sequence = ++generation.current;
    void client.request({ kind: "setStyle", handle: selection.handle,
      property: "clip-path", value: cssCrop(insets) }).catch(() => {
      // A failed live draft must never be mistaken for a saved source edit.
      if (sequence === generation.current) setDraft(null);
    });
  };
  const restore = () => {
    const value = selection.inlineStyles["clip-path"] ?? "";
    void previewAgentForIframe(frame)?.request({ kind: "setStyle", handle: selection.handle,
      property: "clip-path", value }).catch(() => {});
  };
  const start = (edge: CropEdge, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { edge, pointerId: event.pointerId, x: event.clientX,
      y: event.clientY, original: { ...current }, current: { ...current } };
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const next = resolveCropInsetFromEdgeDrag({ edge: active.edge,
      startInsets: active.original, deltaX: event.clientX - active.x,
      deltaY: event.clientY - active.y, scaleX: sx, scaleY: sy,
      width: baseline.box.width, height: baseline.box.height });
    active.current = next;
    setDraft(next);
    preview(next);
  };
  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.stopPropagation();
    gesture.current = null;
    const next = active.current;
    if (Object.keys(next).every(key => next[key as CropEdge] === active.original[key as CropEdge])) return;
    void commit(selection, [{ type: "inline-style", property: "clip-path",
      value: cssCrop(next) === "none" ? null : cssCrop(next) }], "Crop layer")
      .then(saved => {
        if (!saved) restore();
        setDraft(null);
      }).catch(() => {
        restore();
        setDraft(null);
      });
  };
  const cancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    gesture.current = null;
    setDraft(null);
    restore();
  };
  return <>
    <button type="button" aria-label={enabled ? "Close crop tool" : "Crop selected layer"}
      className="absolute -top-7 right-0 rounded border border-studio-accent bg-neutral-900 px-1 text-xs"
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); if (enabled) { setDraft(null); restore(); } setEnabled(!enabled); }}>
      Crop
    </button>
    {enabled && (["top", "right", "bottom", "left"] as const).map(edge => {
      const inset = current[edge] * (edge === "left" || edge === "right" ? sx : sy);
      const style: React.CSSProperties = edge === "top" ? { top: inset - 6, left: "50%" }
        : edge === "bottom" ? { bottom: inset - 6, left: "50%" }
        : edge === "left" ? { left: inset - 6, top: "50%" }
        : { right: inset - 6, top: "50%" };
      return <button key={edge} type="button" aria-label={`Crop ${edge} edge`}
        className="absolute h-3 w-3 rounded-sm border border-studio-accent bg-white cursor-crosshair"
        style={style} onPointerDown={event => start(edge, event)}
        onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} />;
    })}
  </>;
}
