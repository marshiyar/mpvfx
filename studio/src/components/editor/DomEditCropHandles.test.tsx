// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "./domEditing";
import type { OverlayRect } from "./domEditOverlayGeometry";
import { DomEditCropHandles } from "./DomEditCropHandles";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

const overlayRect: OverlayRect = {
  left: 0,
  top: 0,
  width: 200,
  height: 100,
  editScaleX: 1,
  editScaleY: 1,
};

function selectionFor(el: HTMLElement): DomEditSelection {
  return { element: el, id: el.id, selector: `#${el.id}` } as unknown as DomEditSelection;
}

function makeEl(id: string, clip = ""): HTMLElement {
  const el = document.createElement("div");
  el.id = id;
  if (clip) el.style.setProperty("clip-path", clip);
  document.body.append(el);
  return el;
}

function render(
  el: HTMLElement,
  onSessionInsetsChange = vi.fn(),
): { root: Root; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <DomEditCropHandles
        selection={selectionFor(el)}
        overlayRect={overlayRect}
        onSessionInsetsChange={onSessionInsetsChange}
      />,
    );
  });
  return { root, host };
}

describe("DomEditCropHandles draft interaction", () => {
  it("draws exactly four solid square unfilled crop lines that overhang the media", () => {
    const { root, host } = render(makeEl("a"));
    const frame = host.querySelector<HTMLElement>("[data-dom-edit-crop-frame]");
    const lines = Array.from(host.querySelectorAll<HTMLElement>("[data-dom-edit-crop-line]"));

    expect(frame).not.toBeNull();
    expect(lines.map((line) => line.dataset.domEditCropLine)).toEqual([
      "top",
      "right",
      "bottom",
      "left",
    ]);
    expect(frame?.className).not.toMatch(/bg-|border-dashed|rounded/);
    for (const line of lines) expect(line.className).not.toMatch(/border-dashed|rounded/);
    expect(Number.parseFloat(lines[0]!.style.left)).toBeLessThan(0);
    expect(Number.parseFloat(lines[0]!.style.width)).toBeGreaterThan(overlayRect.width);
    expect(Number.parseFloat(lines[3]!.style.top)).toBeLessThan(0);
    expect(Number.parseFloat(lines[3]!.style.height)).toBeGreaterThan(overlayRect.height);
    act(() => root.unmount());
  });

  it("does not lift or rewrite the crop merely by entering and leaving crop mode", () => {
    const element = makeEl("a", "inset(16px round 12px)");
    const { root } = render(element);
    expect(element.style.getPropertyValue("clip-path")).toBe("inset(16px round 12px)");
    act(() => root.unmount());
    expect(element.style.getPropertyValue("clip-path")).toBe("inset(16px round 12px)");
  });

  it("updates only the live draft while dragging an edge", () => {
    const element = makeEl("a", "inset(10px)");
    const onDraft = vi.fn();
    const { root, host } = render(element, onDraft);
    const right = host.querySelector<HTMLButtonElement>('[aria-label="Crop right"]')!;

    act(() => {
      right.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 100 }),
      );
      right.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 80 }),
      );
      right.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 80 }),
      );
    });

    expect(onDraft).toHaveBeenLastCalledWith({ top: 10, right: 30, bottom: 10, left: 10 });
    expect(element.style.getPropertyValue("clip-path")).toBe(
      "inset(10px 30px 10px 10px)",
    );
    act(() => root.unmount());
  });

  it("never translates or repositions media while a crop margin changes", () => {
    const element = makeEl("a", "inset(10px)");
    element.style.transform = "matrix(1, 0, 0, 1, 18, -7)";
    element.style.left = "120px";
    element.style.top = "80px";
    const initialTransform = element.style.transform;
    const initialLeft = element.style.left;
    const initialTop = element.style.top;
    const { root, host } = render(element);
    const left = host.querySelector<HTMLButtonElement>('[aria-label="Crop left"]')!;

    act(() => {
      left.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 9, clientX: 10 }),
      );
      left.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 9, clientX: 30 }),
      );
      left.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerId: 9, clientX: 30 }),
      );
    });

    expect(element.style.clipPath).toBe("inset(10px 10px 10px 30px)");
    expect(element.style.transform).toBe(initialTransform);
    expect(element.style.left).toBe(initialLeft);
    expect(element.style.top).toBe(initialTop);
    act(() => root.unmount());
  });

  it("restores the gesture-start draft when the pointer is cancelled", () => {
    const element = makeEl("a", "inset(10px)");
    const { root, host } = render(element);
    const right = host.querySelector<HTMLButtonElement>('[aria-label="Crop right"]')!;
    act(() => {
      right.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, clientX: 100 }),
      );
      right.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientX: 80 }),
      );
      right.dispatchEvent(
        new PointerEvent("pointercancel", { bubbles: true, pointerId: 2, clientX: 80 }),
      );
    });

    expect(element.style.getPropertyValue("clip-path")).toBe("inset(10px)");
    act(() => root.unmount());
  });

  it("renders no crop controls and preserves unsupported masks", () => {
    const element = makeEl("a", "circle(50% at 50% 50%)");
    const { root, host } = render(element);
    expect(host.querySelector("[data-dom-edit-crop-frame]")).toBeNull();
    expect(element.style.getPropertyValue("clip-path")).toBe("circle(50% at 50% 50%)");
    act(() => root.unmount());
  });
});
