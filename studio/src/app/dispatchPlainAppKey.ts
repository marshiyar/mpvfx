import { useAssetPreviewStore } from "../features/media/assetPreviewStore";
import { canSplitElement } from "../features/timeline/timelineElementSplit";
import { usePlayerStore } from "../player/index";
import type { HotkeyCallbacks } from "./useAppHotkeys";

// fallow-ignore-next-line complexity
/** Exported for tests: the unmodified-key half of the dispatcher, so the
 *  Delete arbitration between keyframes, an automation range and the clip can
 *  be asserted without standing up the whole hook. */
export function dispatchPlainKey(event: KeyboardEvent, key: string, cb: HotkeyCallbacks): void {
  if (key === "f" && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      document.querySelector<HTMLElement>("[data-studio-fullscreen-target]")?.requestFullscreen();
    return;
  }

  if (event.key === "s" && !event.altKey) {
    // Reserve bare `s` for Split even when the current selection cannot split,
    // so secondary listeners do not reinterpret the same key as Snap toggle.
    event.preventDefault();
    const { selectedElementId, elements, currentTime } = usePlayerStore.getState();
    if (selectedElementId) {
      const el = elements.find((e) => (e.key ?? e.id) === selectedElementId);
      if (
        el &&
        canSplitElement(el) &&
        currentTime > el.start &&
        currentTime < el.start + el.duration
      ) {
        void cb.handleTimelineElementSplit(el, currentTime);
        return;
      }
      // Expanded sub-comp children carry a qualified `sourceFile#id` selection
      // that isn't in the raw `elements` list, so the s-key can't resolve them.
      // Nudge toward the razor tool instead of failing silently.
      if (!el && selectedElementId.includes("#")) {
        cb.showToast("Use the razor tool (B) to split clips inside a sub-composition", "info");
        return;
      }
    }
  }

  if (key === "b" && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    const { activeTool, setActiveTool } = usePlayerStore.getState();
    setActiveTool(activeTool === "razor" ? "select" : "razor");
    return;
  }

  if (key === "v" && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    usePlayerStore.getState().setActiveTool("select");
    return;
  }

  if (event.key === "Escape") {
    // The preview closes itself at document level; don't clear its underlying clip first.
    if (useAssetPreviewStore.getState().previewAsset) return;
    const { activeTool, selectedElementId, setActiveTool, setSelectedElementId } =
      usePlayerStore.getState();
    if (activeTool === "razor") {
      if (selectedElementId) setSelectedElementId(null);
      else setActiveTool("select");
      event.preventDefault();
      return;
    }
  }

  if ((event.key === "Delete" || event.key === "Backspace") && !event.altKey) {
    if (usePlayerStore.getState().selectedKeyframes.size > 0) {
      void cb.onDeleteSelectedKeyframes();
      event.preventDefault();
      return;
    }
    // An active automation range owns Delete: useAutomationSelectionKeyboard
    // empties the range in place, pinning the anchors. Fall through WITHOUT
    // preventDefault so that document-level handler still sees the key — this
    // listener is on window/capture, so it runs first and everything below
    // would otherwise win. Without this the press reaches the clip delete
    // below and destroys the whole clip the lane belongs to.
    if (usePlayerStore.getState().automationSelection) return;
    if (event.key === "Backspace") {
      const { selectedElementId, keyframeCache } = usePlayerStore.getState();
      if (selectedElementId && keyframeCache.has(selectedElementId)) {
        void cb.onResetKeyframes();
        event.preventDefault();
        return;
      }
    }
    // The canvas selection is what the user actually drew a marquee around, so
    // it owns Delete whenever it holds something. The timeline mirror of that
    // selection is derived and lossy — a member with no timeline row of its own
    // is dropped from it — so deleting through the timeline removed the handful
    // of clips it knew about and left every other selected element behind,
    // still drawn as selected. The timeline path stays as the fallback for rows
    // with no canvas node to select (audio, a comp that is not the active one).
    const domSel = cb.domEditSelectionRef.current;
    if (domSel) {
      event.preventDefault();
      // The whole marquee group, not just the primary the ref holds.
      void cb.handleDomEditElementDelete(domSel, { expandGroup: true });
      return;
    }
    // Takes the WHOLE selection: `find` returned the first match, so selecting
    // every clip and pressing Delete removed exactly one of them.
    const { selectedElementId, selectedElementIds, elements } = usePlayerStore.getState();
    const selectionKeys = new Set(selectedElementIds);
    if (selectedElementId) selectionKeys.add(selectedElementId);
    const selected = elements.filter((e) => selectionKeys.has(e.key ?? e.id));
    if (selected.length > 0) {
      event.preventDefault();
      void cb.handleTimelineElementsDelete(selected);
    }
    return;
  }

  if (event.key === "r" && !event.shiftKey && !event.altKey && cb.onToggleRecording) {
    event.preventDefault();
    cb.onToggleRecording();
  }
}
