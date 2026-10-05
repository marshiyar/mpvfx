// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "../domEditing";
import type { OverlayRect } from "../domEditOverlayGeometry";
import { DomEditCropHandles } from "../DomEditCropHandles";

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
  rect = overlayRect,
): { root: Root; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <DomEditCropHandles
        selection={selectionFor(el)}
        overlayRect={rect}
        onSessionInsetsChange={onSessionInsetsChange}
      />,
    );
  });
  return { root, host };
}

describe("DomEditCropHandles draft interaction", () => {
  it("draws a square-corner cropped outline, four square handles, and larger edge hit strips", () => {
    const { root, host } = render(makeEl("a"));
    const frame = host.querySelector<HTMLElement>("[data-dom-edit-crop-frame]");
    const outline = host.querySelector<HTMLElement>("[data-dom-edit-crop-outline]");
    const lines = Array.from(host.querySelectorAll<HTMLElement>("[data-dom-edit-crop-line]"));
    const knobs = Array.from(host.querySelectorAll<HTMLElement>("[data-dom-edit-crop-knob]"));
    const handles = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-dom-edit-crop-handle]"));

    expect(frame).not.toBeNull();
    expect(outline).not.toBeNull();
    expect(outline?.className).not.toMatch(/rounded|bg-/);
    expect(outline?.style.width).toBe("200px");
    expect(outline?.style.height).toBe("100px");
    expect(lines.map((line) => line.dataset.domEditCropLine)).toEqual([
      "top",
      "right",
      "bottom",
      "left",
    ]);
    expect(frame?.className).not.toMatch(/bg-|border-dashed|rounded/);
    for (const line of lines) expect(line.className).not.toMatch(/border-dashed|rounded/);
    expect(knobs.map((knob) => knob.dataset.domEditCropKnob)).toEqual([
      "top", "right", "bottom", "left",
    ]);
    for (const knob of knobs) expect(knob.className).not.toMatch(/rounded/);
    expect(handles[0]?.style.height).toBe("12px");
    expect(handles[1]?.style.width).toBe("12px");
    expect(Number.parseFloat(lines[0]!.style.left)).toBeLessThan(0);
    expect(Number.parseFloat(lines[0]!.style.width)).toBeGreaterThan(overlayRect.width);
    expect(Number.parseFloat(lines[3]!.style.top)).toBeLessThan(0);
    expect(Number.parseFloat(lines[3]!.style.height)).toBeGreaterThan(overlayRect.height);
    act(() => root.unmount());
  });

  it("keeps outline and handles on the cropped bounds at editor zoom", () => {
    const zoomedRect: OverlayRect = {
      ...overlayRect,
      width: 400,
      height: 200,
      editScaleX: 2,
      editScaleY: 2,
    };
    const { root, host } = render(makeEl("zoomed", "inset(10px 20px 30px 40px)"), vi.fn(), zoomedRect);
    const outline = host.querySelector<HTMLElement>("[data-dom-edit-crop-outline]")!;
    const top = host.querySelector<HTMLElement>('[data-dom-edit-crop-line="top"]')!;
    const rightHandle = host.querySelector<HTMLElement>('[data-dom-edit-crop-handle="right"]')!;
    expect(outline.style.left).toBe("80px");
    expect(outline.style.top).toBe("20px");
    expect(outline.style.width).toBe("280px");
    expect(outline.style.height).toBe("120px");
    expect(top.style.left).toBe("68px");
    expect(top.style.width).toBe("304px");
    expect(rightHandle.style.left).toBe("354px");
    expect(rightHandle.style.height).toBe("144px");
    act(() => root.unmount());
  });

  it("keeps the cropped rectangle in the element frame before rotation", () => {
    const element = makeEl("rotated", "inset(10px)");
    element.style.transform = "matrix(0, 1, -1, 0, 0, 0)";
    Object.defineProperty(element, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(element, "offsetHeight", { configurable: true, value: 100 });
    const rotatedAabb: OverlayRect = {
      ...overlayRect, left: 50, top: 20, width: 100, height: 200,
    };
    const { root, host } = render(element, vi.fn(), rotatedAabb);
    const frame = host.querySelector<HTMLElement>("[data-dom-edit-crop-frame]")!;
    const outline = host.querySelector<HTMLElement>("[data-dom-edit-crop-outline]")!;
    expect(frame.style.transform).toBe("rotate(90deg)");
    expect(frame.style.width).toBe("200px");
    expect(frame.style.height).toBe("100px");
    expect(outline.style.left).toBe("10px");
    expect(outline.style.top).toBe("10px");
    expect(outline.style.width).toBe("180px");
    expect(outline.style.height).toBe("80px");
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

  it.each(["pointercancel", "lostpointercapture"])("restores the gesture-start draft on %s", (ending) => {
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
        new PointerEvent(ending, { bubbles: true, pointerId: 2, clientX: 80 }),
      );
    });

    expect(element.style.getPropertyValue("clip-path")).toBe("inset(10px)");
    act(() => {
      right.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientX: 50 }));
      right.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, clientX: 50 }));
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
