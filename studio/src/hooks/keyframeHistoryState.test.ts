import { afterEach, describe, expect, it } from "vitest";
import { usePlayerStore } from "../player/store/playerStore";
import { clearKeyframeInteractionAfterHistory } from "./keyframeHistoryState";

afterEach(() => usePlayerStore.getState().reset());

describe("clearKeyframeInteractionAfterHistory", () => {
  it("clears source-relative selection, active identity, and ease focus", () => {
    usePlayerStore.setState({
      selectedElementId: "index.html#box",
      selectedKeyframes: new Set(["stale-key"]),
      focusedEaseSegment: {
        elementId: "index.html#box",
        animationId: "position",
        tweenPercentage: 50,
        projectId: "project",
        sessionEpoch: 1,
        nonce: 1,
      },
    });
    usePlayerStore.getState().setActiveKeyframeTarget({
      elementId: "index.html#box",
      animationId: "position",
      propertyGroup: "position",
      tweenPercentage: 50,
    });

    clearKeyframeInteractionAfterHistory();

    const state = usePlayerStore.getState();
    expect(state.selectedElementId).toBe("index.html#box");
    expect(state.selectedKeyframes).toEqual(new Set());
    expect(state.activeKeyframeTarget).toBeNull();
    expect(state.activeKeyframePct).toBeNull();
    expect(state.focusedEaseSegment).toBeNull();
  });
});
