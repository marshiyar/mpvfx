// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "./domEditingTypes";
import { PropertyPanel3dTransform } from "./propertyPanel3dTransform";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

function selection(): DomEditSelection {
  const element = document.createElement("div");
  document.body.append(element);
  return {
    element,
    id: "card",
    label: "Card",
    tagName: "DIV",
    sourceFile: "index.html",
    compositionPath: "index.html",
    isCompositionHost: false,
    isInsideLockedComposition: false,
    boundingBox: { x: 0, y: 0, width: 100, height: 100 },
    textContent: null,
    dataAttributes: {},
    inlineStyles: {},
    computedStyles: {},
    textFields: [],
    capabilities: {
      canSelect: true,
      canEditStyles: true,
      canCrop: true,
      canMove: true,
      canResize: true,
      canApplyManualOffset: true,
      canApplyManualSize: true,
      canApplyManualRotation: true,
    },
  };
}

function renderTransform(
  runtimeValues: Record<string, number>,
  onCommitAnimatedProperty = vi.fn().mockResolvedValue(undefined),
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const element = selection();
  act(() => {
    root.render(
      <PropertyPanel3dTransform
        gsapRuntimeValues={runtimeValues}
        gsapAnimId={null}
        gsapKeyframes={null}
        currentPct={0}
        elStart={0}
        elDuration={5}
        element={element}
        onCommitAnimatedProperty={onCommitAnimatedProperty}
        onSeekToTime={vi.fn()}
      />,
    );
  });
  return { host, root, element, onCommitAnimatedProperty };
}

describe("PropertyPanel3dTransform reset controls", () => {
  it("resets each non-default field to its stable identity value with one property commit", () => {
    const rendered = renderTransform({
      z: 42,
      scale: 1.5,
      rotationX: 10,
      rotationY: -20,
      rotationZ: 35,
      transformPerspective: 900,
      x: 71,
    });
    const expected = [
      ["Z", "z", 0],
      ["Scale", "scale", 1],
      ["RotX", "rotationX", 0],
      ["RotY", "rotationY", 0],
      ["RotZ", "rotationZ", 0],
      ["Perspective", "transformPerspective", 0],
    ] as const;

    for (const [label, property, value] of expected) {
      const reset = rendered.host.querySelector<HTMLButtonElement>(
        `[aria-label="Reset ${label}"]`,
      );
      expect(reset, label).not.toBeNull();
      const callsBefore = rendered.onCommitAnimatedProperty.mock.calls.length;
      act(() => reset?.click());
      expect(rendered.onCommitAnimatedProperty).toHaveBeenCalledTimes(callsBefore + 1);
      expect(rendered.onCommitAnimatedProperty).toHaveBeenLastCalledWith(
        rendered.element,
        property,
        value,
      );
    }

    expect(rendered.onCommitAnimatedProperty.mock.calls.flat()).not.toContain("x");
    act(() => rendered.root.unmount());
  });

  it("does not show reset controls for fields already at their identity defaults", () => {
    const { host, root, onCommitAnimatedProperty } = renderTransform({});
    for (const label of ["Z", "Scale", "RotX", "RotY", "RotZ", "Perspective"]) {
      expect(host.querySelector(`[aria-label="Reset ${label}"]`)).toBeNull();
    }
    expect(onCommitAnimatedProperty).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
