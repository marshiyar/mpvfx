// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineElement } from "../store/playerStore";
import {
  KeyframeDiamondContextMenu,
  type KeyframeDiamondContextMenuState,
} from "./KeyframeDiamondContextMenu";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

const element = { id: "box", start: 0, duration: 2, track: 0 } as unknown as TimelineElement;

const state: KeyframeDiamondContextMenuState = {
  x: 10,
  y: 10,
  element,
  elementId: "box",
  percentage: 50,
  tweenPercentage: 25,
  propertyGroup: "position",
  animationId: "box-to-1-position",
};

function clickMenuItem(label: string, props: Partial<Record<string, unknown>>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <KeyframeDiamondContextMenu
        state={state}
        onClose={() => {}}
        onDelete={vi.fn()}
        onDeleteAll={vi.fn()}
        {...props}
      />,
    ),
  );
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  act(() => button?.click());
  act(() => root.unmount());
  host.remove();
}

describe("KeyframeDiamondContextMenu", () => {
  // Two animations can carry a keyframe at the same clip percentage. Dropping the
  // property group / tween percentage / animation id here sends the mutation back
  // to first-match-by-percentage, which retimes or deletes the wrong tween.
  it("hands every action the full keyframe identity, not just the percentage", () => {
    const onDelete = vi.fn();
    const onMoveToPlayhead = vi.fn();

    clickMenuItem("Delete Keyframe", { onDelete });
    clickMenuItem("Move to Playhead", { onMoveToPlayhead });

    const target = {
      percentage: 50,
      tweenPercentage: 25,
      propertyGroup: "position",
      animationId: "box-to-1-position",
    };
    expect(onDelete).toHaveBeenCalledWith("box", target);
    expect(onMoveToPlayhead).toHaveBeenCalledWith(element, target);
  });

  it("preserves the complete native command address through the portaled menu", () => {
    const onDelete = vi.fn();
    const onMoveToPlayhead = vi.fn();
    const native = {
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:box",
      parameterId: "transform.rotation",
      keyframeId: "rotation:60",
      frame: 60,
    };

    clickMenuItem("Delete Keyframe", { state: { ...state, native }, onDelete });
    clickMenuItem("Move to Playhead", {
      state: { ...state, native },
      onMoveToPlayhead,
    });

    expect(onDelete).toHaveBeenCalledWith("box", {
      percentage: 50,
      tweenPercentage: 25,
      propertyGroup: "position",
      animationId: "box-to-1-position",
      native,
    });
    expect(onMoveToPlayhead).toHaveBeenCalledWith(element, {
      percentage: 50,
      tweenPercentage: 25,
      propertyGroup: "position",
      animationId: "box-to-1-position",
      native,
    });
  });

  it("hands grouped native scalar targets intact to every mutating action", () => {
    const onDelete = vi.fn();
    const onDeleteAll = vi.fn();
    const onMoveToPlayhead = vi.fn();
    const onSetNativeInterpolation = vi.fn();
    const nativeTargets = [
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:box",
        parameterId: "transform.position.x",
        keyframeId: "x:30",
        frame: 30,
        hasFollowingKeyframe: true,
      },
      {
        sequenceId: "sequence:main",
        trackId: "track:v1",
        clipId: "clip:box",
        parameterId: "transform.position.y",
        keyframeId: "y:30",
        frame: 30,
        hasFollowingKeyframe: true,
      },
    ] as const;
    const groupedState = { ...state, native: nativeTargets[0], nativeTargets };

    clickMenuItem("Delete Keyframe", { state: groupedState, onDelete, onDeleteAll });
    clickMenuItem("Delete All Keyframes", { state: groupedState, onDeleteAll });
    clickMenuItem("Move to Playhead", { state: groupedState, onMoveToPlayhead, onDeleteAll });
    clickMenuItem("Hold", { state: groupedState, onSetNativeInterpolation, onDeleteAll });

    const groupedTarget = expect.objectContaining({
      native: nativeTargets[0],
      nativeTargets,
    });
    expect(onDelete).toHaveBeenCalledWith("box", groupedTarget);
    expect(onDeleteAll).toHaveBeenCalledWith(element, "box-to-1-position", nativeTargets);
    expect(onMoveToPlayhead).toHaveBeenCalledWith(element, groupedTarget);
    expect(onSetNativeInterpolation).toHaveBeenCalledWith(nativeTargets, { type: "hold" });
  });

  // An arc waypoint on a two-anchor path cannot be dropped on its own, so the
  // caller withholds onDelete rather than offering an entry that does nothing.
  it("hides the single-node delete when no handler is given", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <KeyframeDiamondContextMenu state={state} onClose={() => {}} onDeleteAll={vi.fn()} />,
      ),
    );

    const labels = Array.from(document.body.querySelectorAll("button")).map(
      (button) => button.textContent,
    );
    expect(labels).toEqual(["Delete All Keyframes"]);

    act(() => root.unmount());
    host.remove();
  });

  it("renders one separator before the layer-wide delete", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <KeyframeDiamondContextMenu state={state} onClose={() => {}} onDeleteAll={vi.fn()} />,
      ),
    );

    expect(document.body.querySelectorAll('[role="separator"]')).toHaveLength(1);

    act(() => root.unmount());
    host.remove();
  });

  it("does not offer an ease editor for the first keyframe", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <KeyframeDiamondContextMenu
          state={{ ...state, percentage: 0, tweenPercentage: 0 }}
          onClose={() => {}}
          onDeleteAll={vi.fn()}
          onEditEase={vi.fn()}
        />,
      ),
    );

    expect(
      Array.from(document.body.querySelectorAll("button")).map((button) => button.textContent),
    ).toEqual(["Delete All Keyframes"]);

    act(() => root.unmount());
    host.remove();
  });

  it("names the edited segment by its destination keyframe", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <KeyframeDiamondContextMenu
          state={state}
          onClose={() => {}}
          onDeleteAll={vi.fn()}
          onEditEase={vi.fn()}
        />,
      ),
    );

    expect(
      document.body.querySelector('[aria-label="Edit easing for incoming segment ending at 50% keyframe"]'),
    ).not.toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  // The layer-wide delete takes every keyframed tween. Opened from a diamond it
  // has to stay on that diamond's own lane, or right-clicking the opacity lane
  // silently clears position too.
  it("deletes all keyframes from the animation that opened the menu", () => {
    const onDeleteAll = vi.fn();

    clickMenuItem("Delete All Keyframes", { onDeleteAll });

    expect(onDeleteAll).toHaveBeenCalledExactlyOnceWith(element, "box-to-1-position");
  });

  it("preserves the exact native parameter address when deleting every keyframe", () => {
    const onDeleteAll = vi.fn();
    const native = {
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:box",
      parameterId: "transform.rotation",
      keyframeId: "rotation:60",
      frame: 60,
    };

    clickMenuItem("Delete All Keyframes", {
      state: { ...state, native },
      onDeleteAll,
    });

    expect(onDeleteAll).toHaveBeenCalledExactlyOnceWith(
      element,
      "box-to-1-position",
      native,
    );
  });

  it("offers typed native outgoing interpolation presets only when a following key exists", () => {
    const onSetNativeInterpolation = vi.fn();
    const native = {
      sequenceId: "sequence:main",
      trackId: "track:v1",
      clipId: "clip:box",
      parameterId: "transform.rotation",
      keyframeId: "rotation:0",
      frame: 0,
      hasFollowingKeyframe: true,
      properties: { rotation: 0 },
      outgoing: { type: "linear" as const },
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <KeyframeDiamondContextMenu
          state={{ ...state, native }}
          onClose={() => {}}
          onDeleteAll={vi.fn()}
          onEditEase={vi.fn()}
          onSetNativeInterpolation={onSetNativeInterpolation}
        />,
      ),
    );

    expect(document.body.textContent).toContain("Hold");
    expect(document.body.textContent).toContain("Linear");
    expect(document.body.textContent).toContain("Ease In");
    expect(document.body.textContent).toContain("Ease Out");
    expect(document.body.textContent).toContain("Ease In-Out");
    expect(document.body.textContent).not.toContain("Edit Incoming Segment Ease");
    const linear = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Linear"),
    );
    expect(linear?.textContent).toContain("Current");
    expect(linear?.getAttribute("aria-current")).toBe("true");
    const hold = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Hold"),
    );
    expect(hold?.textContent).not.toContain("Current");
    expect(hold?.hasAttribute("aria-current")).toBe(false);

    const easeOut = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Ease Out"),
    );
    act(() => easeOut?.click());
    expect(onSetNativeInterpolation).toHaveBeenCalledWith(native, {
      type: "cubic-bezier",
      controlPoints: { x1: 0, y1: 0, x2: 0.58, y2: 1 },
    });
    act(() => root.unmount());
    host.remove();

    const lastKey = { ...native, hasFollowingKeyframe: false };
    const secondHost = document.createElement("div");
    document.body.appendChild(secondHost);
    const secondRoot = createRoot(secondHost);
    act(() =>
      secondRoot.render(
        <KeyframeDiamondContextMenu
          state={{ ...state, native: lastKey }}
          onClose={() => {}}
          onDeleteAll={vi.fn()}
          onEditEase={vi.fn()}
          onSetNativeInterpolation={onSetNativeInterpolation}
        />,
      ),
    );
    expect(document.body.textContent).not.toContain("Ease In-Out");
    expect(document.body.textContent).not.toContain("Edit Incoming Segment Ease");
    act(() => secondRoot.unmount());
    secondHost.remove();
  });

  it("visibly identifies an authored custom native cubic interpolation", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <KeyframeDiamondContextMenu
          state={{
            ...state,
            native: {
              sequenceId: "sequence:main",
              trackId: "track:v1",
              clipId: "clip:box",
              parameterId: "transform.rotation",
              keyframeId: "rotation:0",
              frame: 0,
              hasFollowingKeyframe: true,
              properties: { rotation: 0 },
              outgoing: {
                type: "cubic-bezier",
                controlPoints: { x1: 0.25, y1: 0.1, x2: 0.75, y2: 0.9 },
              },
            },
          }}
          onClose={() => {}}
          onDeleteAll={vi.fn()}
          onSetNativeInterpolation={vi.fn()}
        />,
      ),
    );

    expect(document.body.textContent).toContain("Custom");
    expect(document.body.querySelectorAll('button[aria-current="true"]')).toHaveLength(0);

    act(() => root.unmount());
    host.remove();
  });
});
