import { usePlayerStore, type TimelineElement } from "../store/playerStore";
import { matchesMediaProbeSource, probeMissingSourceDurations } from "./mediaProbe";

/** A metadata result belongs to this session and source, never just a reused clip key. */
export function enrichTimelineSourceDurations(
  elements: TimelineElement[],
  isCurrent: () => boolean = () => true,
): void {
  const owner = usePlayerStore.getState();
  void probeMissingSourceDurations(elements, owner.timelineProjectId, (key, duration, target) => {
    usePlayerStore.setState((state) => {
      if (
        !isCurrent() ||
        state.timelineProjectId !== owner.timelineProjectId ||
        state.timelineSessionEpoch !== owner.timelineSessionEpoch
      )
        return state;
      const index = state.elements.findIndex((element) => (element.key ?? element.id) === key);
      const element = state.elements[index];
      if (
        !element ||
        element.sourceDuration === duration ||
        element.tag.toLowerCase() !== target.tag ||
        !matchesMediaProbeSource(element.src, target)
      )
        return state;
      const patched = state.elements.slice();
      patched[index] = { ...element, sourceDuration: duration };
      return { elements: patched };
    });
  });
}
