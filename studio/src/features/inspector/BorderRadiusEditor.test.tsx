// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BorderRadiusEditor } from "./BorderRadiusEditor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

function renderEditor(
  values = { tl: 12, tr: 12, br: 12, bl: 12 },
  disabled = false,
) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const onCommit = vi.fn();
  act(() => root.render(<BorderRadiusEditor {...values} disabled={disabled} onCommit={onCommit} />));
  return { host, root, onCommit };
}

describe("BorderRadiusEditor resets", () => {
  it("resets a linked radius to zero", () => {
    const { host, root, onCommit } = renderEditor();
    const reset = host.querySelector<HTMLButtonElement>('[aria-label="Reset All radius"]');
    expect(reset).not.toBeNull();
    act(() => reset?.click());
    expect(onCommit).toHaveBeenCalledWith("all", 0);
    act(() => root.unmount());
  });

  it("resets each nonzero unlinked corner independently", () => {
    const { host, root, onCommit } = renderEditor({ tl: 4, tr: 12, br: 0, bl: 8 });
    for (const [label, corner] of [
      ["TL", "tl"],
      ["TR", "tr"],
      ["BL", "bl"],
    ] as const) {
      const reset = host.querySelector<HTMLButtonElement>(`[aria-label="Reset ${label} radius"]`);
      expect(reset).not.toBeNull();
      act(() => reset?.click());
      expect(onCommit).toHaveBeenCalledWith(corner, 0);
    }
    expect(host.querySelector('[aria-label="Reset BR radius"]')).toBeNull();
    act(() => root.unmount());
  });

  it("withholds reset at zero and disables it with the editor", () => {
    const zero = renderEditor({ tl: 0, tr: 0, br: 0, bl: 0 });
    expect(zero.host.querySelector('[aria-label="Reset All radius"]')).toBeNull();
    act(() => zero.root.unmount());

    const disabled = renderEditor(undefined, true);
    const reset = disabled.host.querySelector<HTMLButtonElement>('[aria-label="Reset All radius"]');
    expect(reset?.disabled).toBe(true);
    act(() => reset?.click());
    expect(disabled.onCommit).not.toHaveBeenCalled();
    act(() => disabled.root.unmount());
  });
});
