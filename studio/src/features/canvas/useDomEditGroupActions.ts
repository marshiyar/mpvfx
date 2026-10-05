import { useCallback, type MutableRefObject } from "react";
import { trackStudioEvent } from "../../lib/studioTelemetry";
import { isAudioDomElement } from "../timeline/timelineInspector";
import type { DomEditSelection } from "./domEditingTypes";
import type { useGroupCommits } from "./useGroupCommits";

interface GroupActionOptions extends ReturnType<typeof useGroupCommits> {
  domEditGroupSelectionsRef: MutableRefObject<DomEditSelection[]>;
  domEditSelectionRef: MutableRefObject<DomEditSelection | null>;
  setActiveGroupElement: (element: HTMLElement | null) => void;
  showToast: (message: string, tone?: "error" | "info") => void;
}

/** Canvas layout grouping keeps its audible-media guard and selection semantics together. */
export function useDomEditGroupActions({
  domEditGroupSelectionsRef, domEditSelectionRef, groupSelection, ungroupSelection,
  setActiveGroupElement, showToast,
}: GroupActionOptions) {
  const handleGroupSelection = useCallback(() => {
    const group = domEditGroupSelectionsRef.current;
    const single = domEditSelectionRef.current;
    const members = group.length > 0 ? group : single ? [single] : [];
    if (members.length < 2) {
      showToast("Select at least 2 elements to group", "info");
      return;
    }
    // A layout group is a positioned wrapper: it takes the members' bounding
    // box, rebases each child's left/top against it, and adopts the topmost
    // z-index. An <audio> clip has no box — offsetWidth/Height are 0 — so
    // grouping audio produced a 0x0 div with inline left/top written onto
    // elements that have never been laid out, and the timeline gained a
    // wrapper standing for nothing audible. The audio answer to "these clips
    // belong together" is an <hf-audio-group> bus, which the timeline's own FX
    // pointer creates, so the refusal names it rather than just declining.
    if (members.some((m) => isAudioDomElement(m.element))) {
      showToast(
        members.every((m) => isAudioDomElement(m.element))
          ? "Audio clips group into a bus — use FX on the track header"
          : "Can't group audio clips with layout elements",
        "info",
      );
      return;
    }
    trackStudioEvent("group", { action: "create", count: members.length });
    void groupSelection(members);
  }, [domEditGroupSelectionsRef, domEditSelectionRef, groupSelection, showToast]);

  const handleUngroupSelection = useCallback(() => {
    const sel = domEditSelectionRef.current;
    if (!sel?.element.hasAttribute("data-hf-group")) {
      showToast("Select a group to ungroup", "info");
      return;
    }
    // Dissolving the group exits any drill-in (the wrapper is about to vanish).
    trackStudioEvent("group", { action: "ungroup" });
    setActiveGroupElement(null);
    void ungroupSelection(sel);
  }, [domEditSelectionRef, ungroupSelection, setActiveGroupElement, showToast]);

  return { handleGroupSelection, handleUngroupSelection };
}
