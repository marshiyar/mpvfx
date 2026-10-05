import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import type { PreviewRect } from "../../../shared/preview/agentProtocol";
import type { NativeProjectClip, NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { resolveNativeClipSelection } from "../../../shared/project/nativePropertyEditPlan";
import { applyNativeProjectPropertyCommand } from "../../../shared/project/nativeProjectPropertyCommands";
import type { NativeKeyframeProjectCommit } from "../../player/components/deleteSelectedKeyframes";
import { parseInsetClipPathSides, type ClipPathInsetSides } from "../inspector/clipPathHelpers";

export function remoteNativeClipId(state: PreviewElementState): string | null {
  const id = state.dataAttributes["studio-clip-id"];
  return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : null;
}

/** Treat preview metadata as a hint; the native document decides clip identity. */
export function resolveRemoteNativeClip(
  document: NativeProjectDocument,
  state: PreviewElementState,
): { trackId: string; clip: NativeProjectClip } | null {
  const clipId = remoteNativeClipId(state);
  if (!clipId) return null;
  const result = resolveNativeClipSelection(document, {
    attributes: { "data-studio-clip-id": clipId },
    sourceFile: state.sourceFile,
    id: state.id,
    selector: state.selector,
    selectorIndex: state.selectorIndex,
  });
  return result.ok ? result.located : null;
}

export function remoteNativeMarqueeTargets(
  document: NativeProjectDocument,
  observations: readonly PreviewElementState[],
  box: PreviewRect,
): PreviewElementState[] {
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return [];
  const seen = new Set<string>();
  return observations.filter(state => {
    if (!state.visible || state.rect.width <= 0 || state.rect.height <= 0 ||
      state.rect.x >= box.x + box.width || state.rect.x + state.rect.width <= box.x ||
      state.rect.y >= box.y + box.height || state.rect.y + state.rect.height <= box.y) return false;
    const located = resolveRemoteNativeClip(document, state);
    if (!located || seen.has(located.clip.id)) return false;
    seen.add(located.clip.id);
    return true;
  });
}

/** Legacy previews have no native clip map. Permit inspector selection only
 * when the current authored source contains one element with this stable ID. */
export function remoteLegacySelectionTargets(
  observations: readonly PreviewElementState[],
  targets: readonly PreviewElementState[],
  activeSourceFile: string,
): PreviewElementState[] {
  if (!activeSourceFile) return [];
  const peers = observations.filter(state => state.sourceFile === activeSourceFile &&
    state.compositionPath === activeSourceFile);
  const seen = new Set<string>();
  return targets.filter(state => {
    if (!state.visible || state.sourceFile !== activeSourceFile ||
      state.compositionPath !== activeSourceFile || seen.has(state.handle) ||
      !peers.some(peer => peer.handle === state.handle)) return false;
    const hfId = state.dataAttributes["hf-id"];
    if (!state.id && !hfId) return false;
    if (state.id && peers.filter(peer => peer.id === state.id).length !== 1) return false;
    if (hfId && peers.filter(peer => peer.dataAttributes["hf-id"] === hfId).length !== 1) return false;
    seen.add(state.handle);
    return true;
  });
}

function positiveCssPixels(value: string | undefined): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(value ?? "");
  const number = match ? Number(match[1]) : NaN;
  return Number.isFinite(number) && number > 0 && number <= 32768 ? number : null;
}

/** Agent measurements are display hints; reject transformed/cropped boxes for
 * a resize gesture because their visible rectangle is not the source box. */
export function remoteNativeResizeBaseline(state: PreviewElementState): { width: number; height: number } | null {
  const crop = state.computedStyles["clip-path"] ?? state.inlineStyles["clip-path"];
  if (crop && crop !== "none") return null;
  return remoteNativeCropBaseline(state)?.box ?? null;
}

/** A saved resize revision can reach React before the isolated frame has
 * applied its new layout. Keep gesture handles locked until agent geometry
 * reflects the committed size so a handle cannot jump under the pointer. */
export function remoteNativeResizeReady(
  state: PreviewElementState | null,
  expected: { width: number; height: number },
): boolean {
  if (!state) return false;
  const width = positiveCssPixels(state.computedStyles.width);
  const height = positiveCssPixels(state.computedStyles.height);
  return width !== null && height !== null &&
    Math.abs(width - expected.width) <= 0.75 && Math.abs(height - expected.height) <= 0.75;
}

export function remoteNativeCropBaseline(state: PreviewElementState): {
  box: { width: number; height: number }; insets: ClipPathInsetSides;
} | null {
  const transform = state.computedStyles.transform;
  if (transform && transform !== "none") {
    const matrix = /^matrix\(([^)]+)\)$/.exec(transform);
    const values = matrix?.[1]?.split(",").map(Number);
    if (!values || values.length !== 6 ||
      Math.abs(values[0]! - 1) > 1e-6 || Math.abs(values[1]!) > 1e-6 ||
      Math.abs(values[2]!) > 1e-6 || Math.abs(values[3]! - 1) > 1e-6) return null;
  }
  const width = positiveCssPixels(state.computedStyles.width);
  const height = positiveCssPixels(state.computedStyles.height);
  const value = state.inlineStyles["clip-path"] || state.computedStyles["clip-path"] || "none";
  const parsed = value === "none" ? { top: 0, right: 0, bottom: 0, left: 0 }
    : parseInsetClipPathSides(value);
  return width !== null && height !== null && parsed &&
    parsed.left + parsed.right < width && parsed.top + parsed.bottom < height
    ? { box: { width, height }, insets: parsed } : null;
}

/** Commit a drag as one native project revision; no preview DOM object is used. */
export async function commitRemoteNativeMove(
  document: NativeProjectDocument,
  state: PreviewElementState,
  delta: { x: number; y: number },
  commit: (change: NativeKeyframeProjectCommit) => Promise<boolean>,
): Promise<boolean> {
  return commitRemoteNativeGroupMove(document, [state], delta, commit);
}

/** Multi-selection move is one native batch and one durable Undo step. */
export async function commitRemoteNativeGroupMove(
  document: NativeProjectDocument,
  states: readonly PreviewElementState[],
  delta: { x: number; y: number },
  commit: (change: NativeKeyframeProjectCommit) => Promise<boolean>,
): Promise<boolean> {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return false;
  if (states.length === 0 || states.length > 100) return false;
  const seen = new Set<string>();
  const located = states.map(state => resolveRemoteNativeClip(document, state));
  if (located.some(item => !item)) return false;
  const commands = located.flatMap(item => {
    if (!item || seen.has(item.clip.id)) return [];
    seen.add(item.clip.id);
    return ([
      ["transform.position.x", delta.x],
      ["transform.position.y", delta.y],
    ] as const).filter(([, amount]) => amount !== 0).map(([parameterId, amount]) => {
      const address = { sequenceId: document.sequence.id, trackId: item.trackId,
        clipId: item.clip.id, parameterId };
      const hasTrack = item.clip.parameterTracks.some(track => track.parameterId === parameterId);
      if (hasTrack) return { type: "offset-track" as const, address, delta: amount };
      const baseline = item.clip.staticParameters?.[parameterId];
      return { type: "set-static" as const, address,
        value: (typeof baseline === "number" ? baseline : 0) + amount };
    });
  });
  if (commands.length === 0) return true;
  const result = applyNativeProjectPropertyCommand(document, { type: "batch", commands });
  if (!result.ok) return false;
  return commit({ document: result.document,
    inverse: { type: "restore-document", document }, label: seen.size > 1 ? "Move layers" : "Move layer" });
}

/** Rotate the whole native curve by a gesture delta in one undoable revision. */
export async function commitRemoteNativeRotation(
  document: NativeProjectDocument,
  state: PreviewElementState,
  deltaDegrees: number,
  commit: (change: NativeKeyframeProjectCommit) => Promise<boolean>,
): Promise<boolean> {
  if (!Number.isFinite(deltaDegrees) || Math.abs(deltaDegrees) > 3600) return false;
  const located = resolveRemoteNativeClip(document, state);
  if (!located) return false;
  if (deltaDegrees === 0) return true;
  const parameterId = "transform.rotation";
  const address = { sequenceId: document.sequence.id, trackId: located.trackId,
    clipId: located.clip.id, parameterId };
  const hasTrack = located.clip.parameterTracks.some(track => track.parameterId === parameterId);
  const baseline = located.clip.staticParameters?.[parameterId];
  const command = hasTrack
    ? { type: "offset-track" as const, address, delta: deltaDegrees }
    : { type: "set-static" as const, address,
      value: (typeof baseline === "number" ? baseline : 0) + deltaDegrees };
  const result = applyNativeProjectPropertyCommand(document, command);
  return result.ok && commit({ document: result.document,
    inverse: { type: "restore-document", document }, label: "Rotate layer" });
}

/** Resize the displayed box from its lower-right corner; source pixels stay intact. */
export async function commitRemoteNativeResize(
  document: NativeProjectDocument,
  state: PreviewElementState,
  size: { width: number; height: number },
  commit: (change: NativeKeyframeProjectCommit) => Promise<boolean>,
): Promise<boolean> {
  if (![size.width, size.height].every(value => Number.isFinite(value) && value > 0 && value <= 32768)) return false;
  if (!remoteNativeResizeBaseline(state)) return false;
  const located = resolveRemoteNativeClip(document, state);
  if (!located) return false;
  const commands = ([
    ["layout.width", size.width],
    ["layout.height", size.height],
  ] as const).map(([parameterId, value]) => {
    const address = { sequenceId: document.sequence.id, trackId: located.trackId,
      clipId: located.clip.id, parameterId };
    const hasTrack = located.clip.parameterTracks.some(track => track.parameterId === parameterId);
    // A resize gesture supplies absolute dimensions. Animated dimensions need
    // a trusted value at the current native frame before their curve can move.
    if (hasTrack) return null;
    return { type: "set-static" as const, address, value };
  });
  if (commands.some(command => command === null)) return false;
  const result = applyNativeProjectPropertyCommand(document, {
    type: "batch", commands: commands.filter(command => command !== null),
  });
  return result.ok && commit({ document: result.document,
    inverse: { type: "restore-document", document }, label: "Resize layer" });
}
