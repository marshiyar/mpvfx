import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import type { NativeProjectClip, NativeProjectDocument } from "../../../shared/project/nativeProjectDocument";
import { resolveNativeClipSelection } from "../../../shared/project/nativePropertyEditPlan";
import { applyNativeProjectPropertyCommand } from "../../../shared/project/nativeProjectPropertyCommands";
import type { NativeKeyframeProjectCommit } from "../../player/components/deleteSelectedKeyframes";

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

/** Commit a drag as one native project revision; no preview DOM object is used. */
export async function commitRemoteNativeMove(
  document: NativeProjectDocument,
  state: PreviewElementState,
  delta: { x: number; y: number },
  commit: (change: NativeKeyframeProjectCommit) => Promise<boolean>,
): Promise<boolean> {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return false;
  const located = resolveRemoteNativeClip(document, state);
  if (!located) return false;
  const commands = ([
    ["transform.position.x", delta.x],
    ["transform.position.y", delta.y],
  ] as const).filter(([, amount]) => amount !== 0).map(([parameterId, amount]) => {
    const address = { sequenceId: document.sequence.id, trackId: located.trackId,
      clipId: located.clip.id, parameterId };
    const hasTrack = located.clip.parameterTracks.some(track => track.parameterId === parameterId);
    if (hasTrack) return { type: "offset-track" as const, address, delta: amount };
    const baseline = located.clip.staticParameters?.[parameterId];
    return { type: "set-static" as const, address,
      value: (typeof baseline === "number" ? baseline : 0) + amount };
  });
  if (commands.length === 0) return true;
  const result = applyNativeProjectPropertyCommand(document, { type: "batch", commands });
  if (!result.ok) return false;
  return commit({ document: result.document,
    inverse: { type: "restore-document", document }, label: "Move layer" });
}
