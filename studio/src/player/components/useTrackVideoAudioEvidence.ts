import { useEffect, useState } from "react";
import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import { previewAgentForIframe } from "../../features/preview/previewAgentClient";
import type { TimelineElement } from "../store/playerStore";

function matchesVideo(element: TimelineElement, state: PreviewElementState): boolean {
  if (state.tag !== "video" || state.dataAttributes["has-audio"] !== "true") return false;
  if (state.sourceFile !== (element.sourceFile || "index.html")) return false;
  if (element.hfId && state.dataAttributes["hf-id"] === element.hfId) return true;
  return Boolean(element.domId || element.id) && state.id === (element.domId || element.id);
}

/** Only an explicitly marked, source-scoped preview video can enter a bus. */
export function audibleVideoKeys(
  elements: readonly TimelineElement[],
  states: readonly PreviewElementState[],
): Set<string> {
  return new Set(elements.filter(element => element.tag.toLowerCase() === "video" &&
    states.some(state => matchesVideo(element, state))).map(element => element.key ?? element.id));
}

/** Agent snapshots are advisory; the durable group transaction rechecks source. */
export function useTrackVideoAudioEvidence(
  iframe: HTMLIFrameElement | null,
  elements: readonly TimelineElement[],
): ReadonlySet<string> {
  const [audible, setAudible] = useState<ReadonlySet<string>>(() => new Set());
  const videoSignature = elements.filter(element => element.tag.toLowerCase() === "video")
    .map(element => [element.key, element.id, element.domId, element.hfId, element.sourceFile].join("\0"))
    .join("\u0001");
  useEffect(() => {
    setAudible(new Set());
    if (!iframe || !videoSignature) return;
    let active = true;
    let unsubscribeReady: (() => void) | null = null;
    const inspect = () => {
      const client = previewAgentForIframe(iframe);
      if (!client?.isReady) return;
      void (async () => {
        const states: PreviewElementState[] = [];
        for (let offset = 0; offset < 3000; offset += 300) {
          const page = await client.request({ kind: "snapshot", offset, limit: 300 });
          if (!Array.isArray(page) || !active) return;
          states.push(...page);
          if (page.length < 300) break;
        }
        if (active) setAudible(audibleVideoKeys(elements, states));
      })().catch(() => { if (active) setAudible(new Set()); });
    };
    const attach = () => {
      unsubscribeReady?.();
      const client = previewAgentForIframe(iframe);
      unsubscribeReady = client?.onReady(inspect) ?? null;
    };
    const onAttached = (event: Event) => {
      if ((event as CustomEvent).detail === iframe) attach();
    };
    window.addEventListener("mpvfx-preview-agent-attached", onAttached);
    attach();
    return () => {
      active = false;
      unsubscribeReady?.();
      window.removeEventListener("mpvfx-preview-agent-attached", onAttached);
    };
  }, [iframe, videoSignature]);
  return audible;
}
