import { usePlayerStore } from "../player/store/playerStore";

/**
 * Undo/Redo swaps authoritative source percentages. Any selected or focused
 * keyframe identity was authored against the previous source revision and must
 * not survive to target a different key on the next edit. Keep the element
 * selected, but clear source-relative keyframe interaction state.
 */
export function clearKeyframeInteractionAfterHistory(): void {
  const state = usePlayerStore.getState();
  state.clearSelectedKeyframes();
  state.setActiveKeyframeTarget(null);
  usePlayerStore.setState({ focusedEaseSegment: null });
}
