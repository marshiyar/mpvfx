// @vitest-environment happy-dom

import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppHotkeys } from "../../hooks/useAppHotkeys";
import { usePlayerStore } from "../../player/store/playerStore";
import type { LeftSidebarHandle } from "../sidebar/LeftSidebar";
import type { DomEditSelection } from "./domEditing";
import { SnapToolbar } from "./SnapToolbar";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  usePlayerStore.getState().reset();
});

function renderToolbar(onSnapChange = vi.fn()) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<SnapToolbar onSnapChange={onSnapChange} />);
  });
  return { root, onSnapChange };
}

function renderCropToolbar(active: boolean, applying = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const crop = {
    available: true,
    active,
    applying,
    onStart: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    onReset: vi.fn(),
  };
  act(() => {
    root.render(<SnapToolbar crop={crop} />);
  });
  return { host, root, crop };
}

function AppHotkeyHarness() {
  const domEditSelectionRef = useRef<DomEditSelection | null>(null);
  const clearDomSelectionRef = useRef<() => void>(() => undefined);
  const domEditSaveTimestampRef = useRef(0);
  const leftSidebarRef = useRef<LeftSidebarHandle | null>(null);

  useAppHotkeys({
    handleTimelineElementsDelete: vi.fn(async () => {}),
    handleTimelineElementSplit: vi.fn(),
    handleDomEditElementDelete: vi.fn(),
    domEditSelectionRef,
    clearDomSelectionRef,
    editHistory: {
      undo: vi.fn(async () => ({ ok: false })),
      redo: vi.fn(async () => ({ ok: false })),
      state: { undo: [], redo: [] },
    },
    readOptionalProjectFile: vi.fn(async () => ""),
    readProjectFile: vi.fn(async () => ""),
    writeProjectFile: vi.fn(async () => undefined),
    domEditSaveTimestampRef,
    showToast: vi.fn(),
    syncHistoryPreviewAfterApply: vi.fn(async () => undefined),
    waitForPendingDomEditSaves: vi.fn(async () => undefined),
    leftSidebarRef,
    handleCopy: vi.fn(() => false),
    handlePaste: vi.fn(async () => undefined),
    handleCut: vi.fn(async () => false),
    onResetKeyframes: vi.fn(() => false),
    onDeleteSelectedKeyframes: vi.fn(),
  });

  return null;
}

function renderToolbarWithAppHotkeys(onSnapChange = vi.fn()) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <>
        <AppHotkeyHarness />
        <SnapToolbar onSnapChange={onSnapChange} />
      </>,
    );
  });
  return { root, onSnapChange };
}

describe("SnapToolbar keyboard shortcuts", () => {
  it("toggles snap on an unclaimed S keypress", () => {
    const { root, onSnapChange } = renderToolbar();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true }),
      );
    });

    expect(onSnapChange).toHaveBeenCalledWith(expect.objectContaining({ snapEnabled: false }));
    act(() => root.unmount());
  });

  it("does not toggle snap when another handler already prevented S", () => {
    const { root, onSnapChange } = renderToolbar();
    const event = new KeyboardEvent("keydown", {
      key: "s",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();

    act(() => {
      document.dispatchEvent(event);
    });

    expect(onSnapChange).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("does not toggle snap when the app split shortcut claims S without a selected clip", () => {
    const { root, onSnapChange } = renderToolbarWithAppHotkeys();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true }),
      );
    });

    expect(onSnapChange).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

describe("SnapToolbar crop access", () => {
  it("shows an obvious crop entry for a selected visual clip", () => {
    const { host, root, crop } = renderCropToolbar(false);
    const start = host.querySelector<HTMLButtonElement>('[aria-label="Start cropping"]');
    expect(start).not.toBeNull();
    act(() => start?.click());
    expect(crop.onStart).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("shows Apply, Cancel, and Reset while crop mode is active", () => {
    const { host, root } = renderCropToolbar(true);
    expect(host.querySelector('[aria-label="Apply crop"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Cancel crop"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Reset crop"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("does not offer a new crop session while another crop is applying", () => {
    const { host, root } = renderCropToolbar(false, true);
    expect(host.querySelector('[aria-label="Start cropping"]')).toBeNull();
    act(() => root.unmount());
  });
});
