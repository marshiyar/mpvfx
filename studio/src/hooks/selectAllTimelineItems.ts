import { usePlayerStore } from "../player";
import type { NativeProjectDocument } from "../project/nativeProjectDocument";
import { nativeTimelinePropertyLanesForElement } from "../player/components/nativeTimelinePropertyLaneBridge";
import { mergeTimelinePropertyLanes } from "../player/components/TimelinePropertyLanes";
import { timelineKeyframeSelectionKey } from "../player/components/timelineKeyframeIdentity";

/** Select the same logical diamonds the timeline renders, including virtualized rows. */
export function selectAllTimelineItems(
  document: NativeProjectDocument | null,
  clearCanvasSelection?: () => void,
): void {
  const state = usePlayerStore.getState();
  if (state.selectedKeyframes.size) {
    const keys = new Set<string>();
    const ids = state.selectedElementIds.size
      ? state.selectedElementIds
      : new Set([state.selectedElementId]);
    for (const element of state.elements) {
      const id = element.key ?? element.id;
      if (!ids.has(id)) continue;
      const native = document ? nativeTimelinePropertyLanesForElement(document, element) : null;
      const lanes = mergeTimelinePropertyLanes(
        state.gsapAnimations.get(id) ?? [],
        native?.lanes ?? [],
        element.start,
        element.duration,
      );
      for (const lane of lanes)
        for (const key of lane.keyframes) keys.add(timelineKeyframeSelectionKey(id, key));
      state.setClipExpanded(id, true);
    }
    usePlayerStore.setState({ selectedKeyframes: keys });
    return;
  }
  const elements = state.elements.filter(
    (element) => element.structuralRole !== "composition-root" && !element.timelineLocked,
  );
  // Offscreen/hidden clips may have no canvas node. Do not leave a partial
  // canvas selection owning Delete while the complete timeline set is selected.
  clearCanvasSelection?.();
  const ids = new Set(elements.map((element) => element.key ?? element.id));
  usePlayerStore.setState({
    selectedElementIds: ids,
    selectedElementId: ids.values().next().value ?? null,
  });
}
