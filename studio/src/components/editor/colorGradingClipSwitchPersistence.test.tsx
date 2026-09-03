// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeHfColorGrading } from "@hyperframes/core/color-grading";
import type { DomEditSelection } from "./domEditing";
import { colorGradingWithAdjust } from "./propertyPanelColorGradingControls";
import { ColorGradingSliderControl } from "./propertyPanelColorGradingSlider";
import { useColorGradingController } from "./useColorGradingController";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function makeClip(id: string): DomEditSelection {
  return {
    element: document.createElement("video"),
    id,
    selector: `#${id}`,
    label: id,
    tagName: "video",
    sourceFile: "index.html",
    compositionPath: "index.html",
    isCompositionHost: false,
    isInsideLockedComposition: false,
    boundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
    textContent: "",
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
  } as DomEditSelection;
}

type DurableCommit = (
  attr: string,
  value: string | null,
  onSettled?: (ok: boolean) => void,
) => void;

function ClipGradePanel({
  clip,
  onDurableCommit,
}: {
  clip: DomEditSelection;
  onDurableCommit: DurableCommit;
}) {
  const controller = useColorGradingController({
    projectId: "project",
    element: clip,
    onSetAttributeLive: onDurableCommit,
  });
  const exposure = Math.round(controller.grading.adjust.exposure * 100);

  return (
    <ColorGradingSliderControl
      label="Exposure"
      value={exposure}
      min={-200}
      max={200}
      step={5}
      scale={100}
      displayValue={String(exposure)}
      onCommit={(nextValue) =>
        controller.commitColorGrading(
          colorGradingWithAdjust(controller.grading, "exposure", nextValue / 100),
        )
      }
    />
  );
}

function KeyedEditor({
  clip,
  onDurableCommit,
}: {
  clip: DomEditSelection;
  onDurableCommit: DurableCommit;
}) {
  return (
    <ClipGradePanel
      key={`${clip.sourceFile}:${clip.id}`}
      clip={clip}
      onDurableCommit={onDurableCommit}
    />
  );
}

function changeRange(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("expected native range value setter");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("durably persists clip A's final slider edit exactly once when the keyed panel switches to clip B", () => {
  vi.useFakeTimers();
  const clipA = makeClip("clip-a");
  const clipB = makeClip("clip-b");
  const persistA = vi.fn<DurableCommit>((_attr, _value, onSettled) => onSettled?.(true));
  const persistB = vi.fn<DurableCommit>((_attr, _value, onSettled) => onSettled?.(true));
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);

  act(() => root.render(<KeyedEditor clip={clipA} onDurableCommit={persistA} />));
  const exposure = host.querySelector<HTMLInputElement>('input[aria-label="Exposure"]');
  if (!exposure) throw new Error("expected clip A exposure slider");
  act(() => changeRange(exposure, "100"));
  expect(persistA).not.toHaveBeenCalled();

  act(() => root.render(<KeyedEditor clip={clipB} onDurableCommit={persistB} />));

  expect(persistA).toHaveBeenCalledTimes(1);
  const [attr, serialized] = persistA.mock.calls[0] ?? [];
  expect(attr).toBe("color-grading");
  expect(normalizeHfColorGrading(serialized)?.adjust.exposure).toBe(1);

  act(() => vi.advanceTimersByTime(400));
  expect(persistA).toHaveBeenCalledTimes(1);
  expect(persistB).not.toHaveBeenCalled();
});
