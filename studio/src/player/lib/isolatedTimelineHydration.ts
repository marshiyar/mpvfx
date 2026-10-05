import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import type { TimelineElement } from "../store/playerStore";
import { buildTimelineElementKey } from "./timelineElementHelpers";

function positiveNumber(value: string | undefined): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function uniqueStateById(states: readonly PreviewElementState[], id: string): PreviewElementState | null {
  const matches = states.filter(state => state.id === id);
  return matches.length === 1 ? matches[0] : null;
}

function safeSourceFile(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !path.startsWith("/") &&
    !path.includes("\\") && !path.includes("\0") && !path.includes("?") && !path.includes("#") &&
    path.split("/").every(part => part !== "" && part !== "." && part !== "..") &&
    path.toLowerCase().endsWith(".html");
}

/** Observed preview metadata enriches a manifest row; duplicate ids stay unresolved. */
export function hydrateIsolatedTimelineElements(
  elements: readonly TimelineElement[],
  states: readonly PreviewElementState[],
): TimelineElement[] {
  return elements.map((element, index) => {
    const host = uniqueStateById(states, element.id);
    if (!host || host.tag !== element.tag.toLowerCase() || !safeSourceFile(host.sourceFile)) return element;
    const attrs = host.dataAttributes;
    const groupId = attrs["audio-group"];
    const bus = groupId ? uniqueStateById(states, groupId) : null;
    const z = Number.parseInt(host.inlineStyles["z-index"] ?? host.computedStyles["z-index"] ?? "", 10);
    const volume = positiveNumber(attrs.volume);
    const domId = host.id || undefined;
    const sourceFile = host.sourceFile || "index.html";
    const selector = host.selector;
    return {
      ...element,
      key: buildTimelineElementKey({
        id: element.id, fallbackIndex: index, domId, selector,
        selectorIndex: host.selectorIndex, sourceFile,
      }),
      domId,
      hfId: attrs["hf-id"] || undefined,
      selector,
      selectorIndex: host.selectorIndex,
      sourceFile,
      hidden: attrs.hidden !== undefined,
      timelineLocked: attrs["timeline-locked"] !== undefined,
      timelineRole: attrs["timeline-role"] || undefined,
      fxChain: attrs["fx-chain"] || undefined,
      automation: attrs.automation || undefined,
      colorGrading: attrs["color-grading"] || undefined,
      volume,
      audioGroup: groupId || undefined,
      audioGroupLabel: bus ? bus.dataAttributes.label || groupId : undefined,
      audioGroupVolume: bus ? positiveNumber(bus.dataAttributes.volume) ?? 1 : undefined,
      audioGroupHidden: bus ? bus.dataAttributes.hidden !== undefined : undefined,
      audioGroupFxChain: bus?.dataAttributes["fx-chain"] || undefined,
      audioGroupAutomation: bus?.dataAttributes.automation || undefined,
      ...(Number.isFinite(z) ? { zIndex: z,
        hasExplicitZIndex: host.inlineStyles["z-index"] !== undefined } : {}),
    };
  });
}
