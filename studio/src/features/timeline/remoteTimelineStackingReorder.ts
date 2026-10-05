import type { TimelineElement } from "../../player/store/playerStore";
import type { TimelineStackingReorderIntent } from "../../player/components/timelineStacking";
import { previewAgentForIframe } from "../preview/previewAgentClient";
import { previewOriginFromIframe } from "../../player/lib/previewUrl";
import { previewOriginForProject } from "../../../shared/desktopPreviewOrigin";
import { commitRemoteStackingBatch } from "../canvas/remoteStackingBatchTransaction";
import type { RemoteInspectorWriteDeps } from "../canvas/remoteInspectorSourceTransaction";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";

/** Persist a single-clip move's complete z cascade from current, source-scoped agent states. */
export async function applyRemoteTimelineStackingReorder(input: {
  iframe: HTMLIFrameElement;
  projectId: string;
  intent: TimelineStackingReorderIntent;
  timelineElements: readonly TimelineElement[];
  activeCompPath: string | null;
  coalesceKey: string;
  deps: RemoteInspectorWriteDeps;
}): Promise<boolean> {
  const { iframe, projectId, intent, timelineElements, activeCompPath, coalesceKey, deps } = input;
  if (intent.zIndexChanges.length === 0) return false;
  if (previewOriginFromIframe(iframe) !== previewOriginForProject(projectId)) {
    throw new Error("The preview no longer belongs to the selected project");
  }
  const agent = previewAgentForIframe(iframe);
  if (!agent?.isReady) throw new Error("The isolated preview is not ready for layer ordering");
  const states: PreviewElementState[] = [];
  for (let offset = 0; offset < 3000; offset += 300) {
    const page = await agent.request({ kind: "snapshot", offset, limit: 300 });
    if (!Array.isArray(page)) throw new Error("The preview layer snapshot is unavailable");
    states.push(...page);
    if (page.length < 300) break;
  }
  if (!agent.isReady) throw new Error("The preview changed while ordering layers");
  const entries = intent.zIndexChanges.map(change => {
    const timeline = timelineElements.find(el => (el.key ?? el.id) === change.key);
    const sourceFile = change.sourceFile ?? timeline?.sourceFile ?? activeCompPath ?? "index.html";
    const domId = change.domId ?? timeline?.domId;
    const hfId = timeline?.hfId;
    const matches = states.filter(state => state.sourceFile === sourceFile &&
      (hfId ? state.dataAttributes["hf-id"] === hfId : Boolean(domId) && state.id === domId) &&
      (!timeline || state.tag === timeline.tag.toLowerCase()) &&
      Boolean(state.dataAttributes["studio-clip-id"]));
    if (matches.length !== 1) throw new Error(`Cannot uniquely resolve reordered clip ${change.key}`);
    return { state: matches[0]!, zIndex: change.zIndex };
  });
  return commitRemoteStackingBatch(entries, coalesceKey, deps);
}
