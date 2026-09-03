// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HF_COLOR_GRADING_EFFECT_APPLY_DEFAULTS,
  normalizeHfColorGrading,
} from "@hyperframes/core/color-grading";
import { FlatEffectControl } from "./propertyPanelFlatEffectControl";
import type { EffectControl, EffectSpec } from "./propertyPanelFlatEffectSpecs";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("FlatEffectControl resets", () => {
  it("resets a changed toggle to its effect apply default", () => {
    const control: EffectControl = { kind: "toggle", key: "monoScreenInvert", label: "Invert" };
    const effect: EffectSpec = { key: "monoScreen", label: "Mono Screen" };
    const defaultValue = HF_COLOR_GRADING_EFFECT_APPLY_DEFAULTS.monoScreen.monoScreenInvert ?? 0;
    const grading = normalizeHfColorGrading({
      effects: { monoScreenInvert: defaultValue >= 0.5 ? 0 : 1 },
    });
    if (!grading) throw new Error("Expected normalized grading");
    const onCommit = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() =>
      root.render(
        <FlatEffectControl
          control={control}
          effect={effect}
          effects={grading.effects}
          onCommit={onCommit}
        />,
      ),
    );

    const reset = host.querySelector<HTMLButtonElement>('[aria-label="Reset Invert"]');
    expect(reset).not.toBeNull();
    act(() => reset?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onCommit).toHaveBeenCalledWith("monoScreenInvert", defaultValue);
    act(() => root.unmount());
  });
});
