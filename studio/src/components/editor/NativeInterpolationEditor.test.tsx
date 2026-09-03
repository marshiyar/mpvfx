// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeInterpolation } from "../../project/nativeKeyframeTypes";
import { NativeInterpolationEditor } from "./NativeInterpolationEditor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = "";
});

function renderEditor(value: NativeInterpolation = { type: "linear" }) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const onCommit = vi.fn<(value: NativeInterpolation) => void>();
  roots.push(root);
  act(() => root.render(<NativeInterpolationEditor value={value} onCommit={onCommit} />));
  return { host, root, onCommit };
}

function clickChoice(host: HTMLElement, label: string): void {
  const choice = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === label,
  );
  expect(choice, `Expected the ${label} interpolation choice`).toBeDefined();
  act(() => choice?.click());
}

function commitField(host: HTMLElement, label: string, raw: string): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  expect(input, `Expected the ${label} field`).not.toBeNull();
  act(() => {
    input?.focus();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, raw);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    input?.blur();
  });
  return input!;
}

describe("NativeInterpolationEditor", () => {
  it("offers only native Hold, Linear, and Cubic interpolation choices", () => {
    const { host } = renderEditor();
    const labels = Array.from(host.querySelectorAll("button"), (button) =>
      button.textContent?.trim(),
    );

    expect(labels).toEqual(["Hold", "Linear", "Cubic"]);
    expect(host.textContent).not.toMatch(/GSAP|Spring|Wiggle|HTML/i);
    expect(host.querySelector('[aria-label="Interpolation"]')).not.toBeNull();
  });

  it("emits exact typed values for each interpolation choice", () => {
    const { host, onCommit } = renderEditor();

    clickChoice(host, "Hold");
    clickChoice(host, "Linear");
    clickChoice(host, "Cubic");

    expect(onCommit.mock.calls).toEqual([
      [{ type: "hold" }],
      [{ type: "linear" }],
      [
        {
          type: "cubic-bezier",
          controlPoints: { x1: 0.33, y1: 0, x2: 0.67, y2: 1 },
        },
      ],
    ]);
  });

  it("shows labeled cubic fields and documents their supported bounds", () => {
    const { host } = renderEditor({
      type: "cubic-bezier",
      controlPoints: { x1: 0.25, y1: -0.5, x2: 0.8, y2: 1.5 },
    });

    expect(host.querySelector<HTMLInputElement>('[aria-label="Cubic X1"]')?.value).toBe("0.25");
    expect(host.querySelector<HTMLInputElement>('[aria-label="Cubic Y1"]')?.value).toBe("-0.5");
    expect(host.querySelector<HTMLInputElement>('[aria-label="Cubic X2"]')?.value).toBe("0.8");
    expect(host.querySelector<HTMLInputElement>('[aria-label="Cubic Y2"]')?.value).toBe("1.5");
    expect(host.textContent).toContain("X handles: 0–1. Y handles: −1–2.");
  });

  it("clamps X handles and emits one complete cubic value per field commit", () => {
    const { host, onCommit } = renderEditor({
      type: "cubic-bezier",
      controlPoints: { x1: 0.25, y1: -0.5, x2: 0.8, y2: 1.5 },
    });

    commitField(host, "Cubic X1", "4");
    commitField(host, "Cubic X2", "-3");

    expect(onCommit.mock.calls).toEqual([
      [
        {
          type: "cubic-bezier",
          controlPoints: { x1: 1, y1: -0.5, x2: 0.8, y2: 1.5 },
        },
      ],
      [
        {
          type: "cubic-bezier",
          controlPoints: { x1: 1, y1: -0.5, x2: 0, y2: 1.5 },
        },
      ],
    ]);
  });

  it("retains finite Y handles within the supported range and clamps overflow", () => {
    const { host, onCommit } = renderEditor({
      type: "cubic-bezier",
      controlPoints: { x1: 0.25, y1: 0, x2: 0.8, y2: 1 },
    });

    commitField(host, "Cubic Y1", "-0.625");
    commitField(host, "Cubic Y2", "50");

    expect(onCommit.mock.calls).toEqual([
      [
        {
          type: "cubic-bezier",
          controlPoints: { x1: 0.25, y1: -0.625, x2: 0.8, y2: 1 },
        },
      ],
      [
        {
          type: "cubic-bezier",
          controlPoints: { x1: 0.25, y1: -0.625, x2: 0.8, y2: 2 },
        },
      ],
    ]);
  });

  it("rejects nonfinite drafts without emitting a malformed interpolation", () => {
    const { host, onCommit } = renderEditor({
      type: "cubic-bezier",
      controlPoints: { x1: 0.25, y1: 0, x2: 0.8, y2: 1 },
    });

    const input = commitField(host, "Cubic Y1", "Infinity");

    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("0");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain("Enter a finite number");
  });
});
