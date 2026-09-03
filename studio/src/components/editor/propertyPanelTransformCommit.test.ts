// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "./domEditingTypes";
import { GsapEditBlockedError } from "../../hooks/gsapEditOutcome";
import { createTransformCommitHandlers } from "./propertyPanelTransformCommit";

describe("createTransformCommitHandlers", () => {
  it.each([
    [
      "position",
      (handlers: ReturnType<typeof createTransformCommitHandlers>) =>
        handlers.commitManualOffset("x", "20px"),
    ],
    [
      "size",
      (handlers: ReturnType<typeof createTransformCommitHandlers>) =>
        handlers.commitManualSize("width", "200px"),
    ],
    [
      "rotation",
      (handlers: ReturnType<typeof createTransformCommitHandlers>) =>
        handlers.commitManualRotation("45"),
    ],
  ])("propagates blocked %s edits so the field can roll back", async (_name, commit) => {
    const blocked = new GsapEditBlockedError("unroll-required");
    const onCommitAnimatedProperty = vi.fn().mockRejectedValue(blocked);
    const onSetManualOffset = vi.fn();
    const onSetManualSize = vi.fn();
    const onSetManualRotation = vi.fn();
    const element = {
      id: "box",
      selector: "#box",
      element: document.createElement("div"),
      boundingBox: { width: 100, height: 100 },
    } as unknown as DomEditSelection;
    const handlers = createTransformCommitHandlers({
      element,
      styles: {},
      hasGsapAnimation: true,
      gsapAnimId: "#box-to-position",
      gsapKeyframes: null,
      currentPct: 0,
      onCommitAnimatedProperty,
      onAddKeyframe: undefined,
      onSetManualOffset,
      onSetManualSize,
      onSetManualRotation,
      showToast: vi.fn(),
    });

    await expect(commit(handlers)).rejects.toBe(blocked);
    expect(onSetManualOffset).not.toHaveBeenCalled();
    expect(onSetManualSize).not.toHaveBeenCalled();
    expect(onSetManualRotation).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "clamps %s animated numeric video positions to the composition boundary",
    async (animated) => {
      const root = document.createElement("main");
      root.setAttribute("data-composition-id", "main");
      root.setAttribute("data-width", "1000");
      root.setAttribute("data-height", "600");
      const video = document.createElement("video");
      root.append(video);
      document.body.append(root);
      root.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }) as DOMRect;
      video.getBoundingClientRect = () =>
        ({ left: 850, top: 250, right: 950, bottom: 350, width: 100, height: 100 }) as DOMRect;

      const selected = {
        id: "video",
        selector: "#video",
        element: video,
        boundingBox: { x: 850, y: 250, width: 100, height: 100 },
      } as unknown as DomEditSelection;
      const onCommitAnimatedProperty = vi.fn();
      const onSetManualOffset = vi.fn();
      const handlers = createTransformCommitHandlers({
        element: selected,
        styles: {},
        hasGsapAnimation: animated,
        gsapAnimId: animated ? "#video-position" : null,
        gsapKeyframes: null,
        currentPct: 0,
        runtimeValues: { x: 0, y: 0 },
        onCommitAnimatedProperty,
        onAddKeyframe: undefined,
        onSetManualOffset,
        onSetManualSize: vi.fn(),
        onSetManualRotation: vi.fn(),
      });

      await handlers.commitManualOffset("x", "300px");

      if (animated) {
        expect(onCommitAnimatedProperty).toHaveBeenCalledWith(selected, "x", 50);
        expect(onSetManualOffset).not.toHaveBeenCalled();
      } else {
        expect(onSetManualOffset).toHaveBeenCalledWith(selected, { x: 50, y: 0 });
        expect(onCommitAnimatedProperty).not.toHaveBeenCalled();
      }
      root.remove();
    },
  );

  it.each([false, true])(
    "uses the cropped video margin when clamping %s numeric positions",
    async (animated) => {
      const root = document.createElement("main");
      root.setAttribute("data-composition-id", "main");
      root.setAttribute("data-width", "1000");
      root.setAttribute("data-height", "600");
      const video = document.createElement("video");
      video.style.clipPath = "inset(0px 50px 0px 0px)";
      root.append(video);
      document.body.append(root);
      root.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }) as DOMRect;
      video.getBoundingClientRect = () =>
        ({ left: 850, top: 250, right: 950, bottom: 350, width: 100, height: 100 }) as DOMRect;

      const selected = {
        id: "cropped-video",
        selector: "#cropped-video",
        element: video,
        boundingBox: { x: 850, y: 250, width: 100, height: 100 },
      } as unknown as DomEditSelection;
      const onCommitAnimatedProperty = vi.fn();
      const onSetManualOffset = vi.fn();
      const handlers = createTransformCommitHandlers({
        element: selected,
        styles: {},
        hasGsapAnimation: animated,
        gsapAnimId: animated ? "#cropped-video-position" : null,
        gsapKeyframes: null,
        currentPct: 0,
        runtimeValues: { x: 0, y: 0 },
        onCommitAnimatedProperty,
        onAddKeyframe: undefined,
        onSetManualOffset,
        onSetManualSize: vi.fn(),
        onSetManualRotation: vi.fn(),
      });

      await handlers.commitManualOffset("x", "300px");

      // The hidden 50px at the right is no longer a margin. The visible edge
      // starts at x=900, so this clip can move 100px before reaching x=1000.
      if (animated) {
        expect(onCommitAnimatedProperty).toHaveBeenCalledWith(selected, "x", 100);
        expect(onSetManualOffset).not.toHaveBeenCalled();
      } else {
        expect(onSetManualOffset).toHaveBeenCalledWith(selected, { x: 100, y: 0 });
        expect(onCommitAnimatedProperty).not.toHaveBeenCalled();
      }
      root.remove();
    },
  );
});
