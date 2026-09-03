// @vitest-environment happy-dom

import React, { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutsPanel } from "./ShortcutsPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

function renderPanel(
  onRender = vi.fn(),
  historyActions?: {
    canUndo: boolean;
    canRedo: boolean;
    undoLabel?: string;
    redoLabel?: string;
    onUndo: () => void;
    onRedo: () => void;
  },
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      <Profiler id="shortcuts-panel" onRender={onRender}>
        <ShortcutsPanel
          disabled={false}
          duration={10}
          inPoint={null}
          outPoint={null}
          setInPoint={vi.fn()}
          setOutPoint={vi.fn()}
          onSeek={vi.fn()}
          historyActions={historyActions}
        />
      </Profiler>,
    );
  });

  const trigger = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Shortcuts and tools"]',
  )!;
  return { host, trigger, onRender };
}

function pressAndClick(target: HTMLElement): void {
  target.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
  );
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
}

function openPanel(trigger: HTMLButtonElement): void {
  act(() => pressAndClick(trigger));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
}

describe("ShortcutsPanel", () => {
  it("keeps additive timeline selection guidance inside Shortcuts and tools", () => {
    const { host, trigger } = renderPanel();

    expect(host.textContent).not.toContain("Selection tool: add clips to selection");
    openPanel(trigger);

    expect(host.textContent).toContain("Shift + click/drag");
    expect(host.textContent).toContain("Selection tool: add clips to selection");
  });

  it("documents frame-precise and coarse selected-keyframe nudging", () => {
    const { host, trigger } = renderPanel();
    openPanel(trigger);

    expect(host.textContent).toContain(", / .");
    expect(host.textContent).toContain("Move selected keyframes 1 frame");
    expect(host.textContent).toContain("⇧, / ⇧.");
    expect(host.textContent).toContain("Move selected keyframes 10 frames");
  });

  it("owns the actionable Undo and Redo controls with their current history labels", () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const { host, trigger } = renderPanel(vi.fn(), {
      canUndo: true,
      canRedo: true,
      undoLabel: "Move timeline clips",
      redoLabel: "Trim clip",
      onUndo,
      onRedo,
    });
    openPanel(trigger);

    const undo = host.querySelector<HTMLButtonElement>('[data-history-action="undo"]');
    const redo = host.querySelector<HTMLButtonElement>('[data-history-action="redo"]');
    expect(undo?.textContent).toContain("Undo Move timeline clips");
    expect(undo?.textContent).toMatch(/(?:Cmd|Ctrl)\+Z/);
    expect(redo?.textContent).toContain("Redo Trim clip");
    expect(redo?.textContent).toMatch(/(?:Cmd|Ctrl)\+Shift\+Z/);

    act(() => {
      undo?.click();
      redo?.click();
    });
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).toHaveBeenCalledOnce();
  });

  it("disables unavailable history actions inside the panel", () => {
    const { host, trigger } = renderPanel(vi.fn(), {
      canUndo: false,
      canRedo: false,
      onUndo: vi.fn(),
      onRedo: vi.fn(),
    });
    openPanel(trigger);

    expect(host.querySelector<HTMLButtonElement>('[data-history-action="undo"]')?.disabled).toBe(
      true,
    );
    expect(host.querySelector<HTMLButtonElement>('[data-history-action="redo"]')?.disabled).toBe(
      true,
    );
  });

  it.each(["page", "button", "panel"] as const)(
    "closes with Escape from the %s-focused position",
    (focusPosition) => {
      const { host, trigger } = renderPanel();
      openPanel(trigger);

      let eventTarget: Document | HTMLElement;
      if (focusPosition === "page") {
        document.body.tabIndex = -1;
        document.body.focus();
        eventTarget = document;
        expect(document.activeElement).toBe(document.body);
      } else if (focusPosition === "button") {
        trigger.focus();
        eventTarget = trigger;
        expect(document.activeElement).toBe(trigger);
      } else {
        const panelInput = host.querySelector<HTMLInputElement>('[aria-label="Jump to frame"]')!;
        panelInput.focus();
        eventTarget = panelInput;
        expect(document.activeElement).toBe(panelInput);
      }

      act(() => {
        eventTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });

      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(host.querySelector('[aria-label="Jump to frame"]')).toBeNull();
    },
  );

  it("closes on capture-phase pointerdown even when its default is prevented", () => {
    const preventDefault = (event: Event) => event.preventDefault();
    document.addEventListener("pointerdown", preventDefault, true);
    const { host, trigger } = renderPanel();
    openPanel(trigger);
    const outside = document.createElement("div");
    document.body.append(outside);
    const pointerDown = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });

    act(() => outside.dispatchEvent(pointerDown));

    document.removeEventListener("pointerdown", preventDefault, true);
    expect(pointerDown.defaultPrevented).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[aria-label="Jump to frame"]')).toBeNull();
  });

  it("does not close on a click inside the panel", () => {
    const { host, trigger } = renderPanel();
    openPanel(trigger);
    const panelInput = host.querySelector<HTMLInputElement>('[aria-label="Jump to frame"]')!;

    act(() => pressAndClick(panelInput));

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[aria-label="Jump to frame"]')).not.toBeNull();
  });

  it("toggles once per trigger click", () => {
    const { trigger } = renderPanel();

    act(() => pressAndClick(trigger));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    act(() => pressAndClick(trigger));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not re-render when Escape is pressed while closed", () => {
    const { trigger, onRender } = renderPanel();
    expect(onRender).toHaveBeenCalledTimes(1);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onRender).toHaveBeenCalledTimes(1);
  });

  it("connects the trigger to the dialog with aria-controls", () => {
    const { host, trigger } = renderPanel();
    openPanel(trigger);
    const panelId = trigger.getAttribute("aria-controls");
    const panel = panelId ? host.querySelector<HTMLElement>(`#${CSS.escape(panelId)}`) : null;

    expect(panelId).not.toBeNull();
    expect(panel?.getAttribute("role")).toBe("dialog");
    // Non-modal on purpose: focus is not trapped and the editor behind stays
    // operable, so aria-modal would lie to assistive tech about inertness.
    expect(panel?.getAttribute("aria-modal")).toBeNull();
    expect(panel?.id).toBe(panelId);
  });
});
