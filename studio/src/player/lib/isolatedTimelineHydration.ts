import type { PreviewElementState } from "../../../shared/preview/agentProtocol";
import type { TimelineElement } from "../store/playerStore";
import type { DomClipChild, SubCompositionHostState } from "../store/playerStore";
import type { ClipManifestClip } from "./playbackTypes";
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
    !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every(part => part !== "" && part !== "." && part !== "..") &&
    path.toLowerCase().endsWith(".html");
}

function observedCompositionId(id: string, compositionSrc?: string | null): string {
  // The manifest qualifies composition hosts as `source.html#dom-id`, while
  // the preview agent reports the actual DOM id. Match only the exact source
  // prefix; filenames themselves may contain literal ? or # characters.
  const prefix = compositionSrc && safeSourceFile(compositionSrc) ? `${compositionSrc}#` : null;
  return prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/** The authored root can outlast the runtime's last timed clip. */
export function isolatedRootDuration(states: readonly PreviewElementState[]): number {
  const root = states.find(state => state.dataAttributes["composition-id"] !== undefined);
  if (!root) return 0;
  const authored = positiveNumber(root.dataAttributes.duration) ||
    positiveNumber(root.dataAttributes["hf-authored-duration"]) || 0;
  if (authored > 0 && authored <= 86400) return authored;
  let furthest = 0;
  for (const state of states) {
    if (state === root || state.tag === "hf-audio-group") continue;
    const start = positiveNumber(state.dataAttributes.start);
    const duration = positiveNumber(state.dataAttributes.duration) ||
      positiveNumber(state.dataAttributes["hf-authored-duration"]);
    if (start !== undefined && duration !== undefined && start + duration <= 86400) {
      furthest = Math.max(furthest, start + duration);
    }
  }
  return furthest;
}

/** Observed preview metadata enriches a manifest row; duplicate ids stay unresolved. */
export function hydrateIsolatedTimelineElements(
  elements: readonly TimelineElement[],
  states: readonly PreviewElementState[],
): TimelineElement[] {
  return elements.map((element, index) => {
    const host = uniqueStateById(states, observedCompositionId(element.id, element.compositionSrc));
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

/** Rebuild display-only nested rows from bounded agent observations. Duplicate
 * IDs cannot be represented by the store's ID-keyed maps, so leave them out. */
export function hydrateIsolatedCompositionChildren(
  clips: readonly ClipManifestClip[],
  states: readonly PreviewElementState[],
): {
  parentMap: Map<string, string>;
  domChildren: DomClipChild[];
  hostState: Map<string, SubCompositionHostState>;
} {
  const empty = () => ({ parentMap: new Map<string, string>(), domChildren: [] as DomClipChild[],
    hostState: new Map<string, SubCompositionHostState>() });
  if (states.length > 3000 || new Set(states.map(state => state.handle)).size !== states.length) return empty();
  const childrenByHandle = new Map<string, PreviewElementState[]>();
  const idCounts = new Map<string, number>();
  for (const state of states) {
    if (state.id) idCounts.set(state.id, (idCounts.get(state.id) ?? 0) + 1);
    if (!state.parent) continue;
    const siblings = childrenByHandle.get(state.parent) ?? [];
    siblings.push(state);
    childrenByHandle.set(state.parent, siblings);
  }
  const uniqueId = (state: PreviewElementState): boolean =>
    state.id.length > 0 && idCounts.get(state.id) === 1 && safeSourceFile(state.sourceFile);
  const parentMap = new Map<string, string>();
  const domChildren: DomClipChild[] = [];
  const hostState = new Map<string, SubCompositionHostState>();
  const seenHosts = new Set<string>();
  for (const clip of clips) {
    if (clip.kind !== "composition" || !clip.id || seenHosts.has(clip.id)) continue;
    seenHosts.add(clip.id);
    const host = uniqueStateById(states, observedCompositionId(clip.id, clip.compositionSrc));
    if (!host || !uniqueId(host)) continue;
    const descendants: PreviewElementState[] = [];
    const visitedDescendants = new Set<string>([host.handle]);
    const visit = (state: PreviewElementState, depth: number): void => {
      if (depth > 64) return;
      for (const child of childrenByHandle.get(state.handle) ?? []) {
        if (visitedDescendants.has(child.handle)) continue;
        visitedDescendants.add(child.handle);
        descendants.push(child);
        visit(child, depth + 1);
      }
    };
    visit(host, 0);
    const innerRoot = descendants.find(state => state.dataAttributes["hf-inner-root"] !== undefined) ?? host;
    const readBus = (state: PreviewElementState) => {
      const groupId = state.dataAttributes["audio-group"];
      const bus = groupId ? uniqueStateById(states, groupId) : null;
      if (!bus || bus.tag !== "hf-audio-group") return groupId ? { audioGroup: groupId } : {};
      return {
        audioGroup: groupId, audioGroupLabel: bus.dataAttributes.label || groupId,
        audioGroupVolume: positiveNumber(bus.dataAttributes.volume) ?? 1,
        audioGroupHidden: bus.dataAttributes.hidden !== undefined,
        ...(bus.dataAttributes["fx-chain"] ? { audioGroupFxChain: bus.dataAttributes["fx-chain"] } : {}),
        ...(bus.dataAttributes.automation ? { audioGroupAutomation: bus.dataAttributes.automation } : {}),
      };
    };
    const visitedRows = new Set<string>([innerRoot.handle]);
    const collectRows = (state: PreviewElementState, parentId: string, depth: number): void => {
      if (depth > 64) return;
      for (const child of childrenByHandle.get(state.handle) ?? []) {
        if (visitedRows.has(child.handle)) continue;
        visitedRows.add(child.handle);
        if (!uniqueId(child)) { if (!child.id) collectRows(child, parentId, depth + 1); continue; }
        const group = child.dataAttributes["hf-group"];
        domChildren.push({ id: child.id, parentId, hostId: host.id,
          label: group || child.id, stackingContextId: "css:root", ...readBus(child) });
        if (group) collectRows(child, child.id, depth + 1);
      }
    };
    collectRows(innerRoot, host.id, 0);
    const visitedState = new Set<string>([innerRoot.handle]);
    const visitState = (state: PreviewElementState, nearestId: string, depth: number): void => {
      if (depth > 64) return;
      for (const child of childrenByHandle.get(state.handle) ?? []) {
        if (visitedState.has(child.handle)) continue;
        visitedState.add(child.handle);
        const id = uniqueId(child) ? child.id : nearestId;
        if (id !== nearestId) {
          parentMap.set(id, nearestId);
          const attrs = child.dataAttributes;
          const value: SubCompositionHostState = {};
          if (attrs.hidden !== undefined) value.hidden = true;
          if (attrs["timeline-locked"] !== undefined) value.timelineLocked = true;
          if (attrs["timeline-role"]) value.timelineRole = attrs["timeline-role"];
          if (attrs["fx-chain"]) value.fxChain = attrs["fx-chain"];
          if (attrs.automation) value.automation = attrs.automation;
          if (attrs["color-grading"]) value.colorGrading = attrs["color-grading"];
          if (Object.keys(value).length) hostState.set(id, value);
        }
        visitState(child, id, depth + 1);
      }
    };
    visitState(innerRoot, host.id, 0);
  }
  return { parentMap, domChildren, hostState };
}
