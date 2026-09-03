// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlatMediaSection } from "./propertyPanelFlatMediaSection";
import type { DomEditSelection } from "./domEditing";
import { useCropToolStore } from "./cropToolStore";
import { DomEditCropHandles } from "./DomEditCropHandles";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  useCropToolStore.getState().deactivate();
  document.body.innerHTML = "";
});

function makeVideoElement(overrides: Partial<DomEditSelection> = {}): DomEditSelection {
  const el = document.createElement("video");
  el.setAttribute("src", "assets/intro-loop.mp4");
  return {
    element: el,
    id: "s1-bg",
    selector: "#s1-bg",
    label: "S1 Background",
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
    ...overrides,
  } as DomEditSelection;
}

function renderSection(overrides: Partial<DomEditSelection> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const element = makeVideoElement(overrides);
  act(() => {
    root.render(
      <FlatMediaSection
        projectDir={null}
        element={element}
        styles={{}}
        onSetStyle={vi.fn()}
        onSetAttribute={vi.fn()}
        onSetHtmlAttribute={vi.fn()}
      />,
    );
  });
  return { host, root };
}

describe("FlatMediaSection — source row", () => {
  it("renders the source path and copies it to clipboard on click", () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    const { host, root } = renderSection();
    expect(host.textContent).toContain("assets/intro-loop.mp4");
    const copyButton = host.querySelector<HTMLButtonElement>('[data-flat-media-copy="true"]');
    expect(copyButton).not.toBeNull();
    act(() => copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("assets/intro-loop.mp4");
    act(() => root.unmount());
  });
});

describe("FlatMediaSection — explicit crop mode", () => {
  it("shows crop measurements only after Crop is started and hides them after Cancel", () => {
    const { host, root } = renderSection();
    const start = host.querySelector<HTMLButtonElement>('[aria-label="Start cropping"]');
    expect(start).not.toBeNull();
    expect(host.querySelector("[data-crop-measurements]")).toBeNull();

    act(() => start?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(host.querySelectorAll("[data-crop-measurement]")).toHaveLength(4);

    const cancel = host.querySelector<HTMLButtonElement>('[aria-label="Cancel crop"]');
    act(() => cancel?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(host.querySelector("[data-crop-measurements]")).toBeNull();
    act(() => root.unmount());
  });

  it("keeps crop edits as a draft and Cancel restores the exact pre-mode clip", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const element = makeVideoElement();
    element.element.style.setProperty("clip-path", "inset(16px round 12px)");
    const onSetStyle = vi.fn();

    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{ "clip-path": "inset(16px round 12px)" }}
          onSetStyle={onSetStyle}
          onSetAttribute={vi.fn()}
          onSetHtmlAttribute={vi.fn()}
        />,
      );
    });
    act(() =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Start cropping"]')
        ?.click(),
    );
    const top = host.querySelector<HTMLInputElement>('[data-crop-measurement="top"] input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(top, "28");
      top.dispatchEvent(new Event("input", { bubbles: true }));
      top.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Reset crop"]')?.click());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Cancel crop"]')?.click());
    await act(async () => Promise.resolve());

    expect(onSetStyle).not.toHaveBeenCalled();
    expect(element.element.style.getPropertyValue("clip-path")).toBe(
      "inset(16px round 12px)",
    );
    expect(useCropToolStore.getState().targetKey).toBeNull();
    act(() => root.unmount());
  });

  it("persists one final crop only when Apply succeeds", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const element = makeVideoElement();
    const onSetStyle = vi.fn().mockResolvedValue({ ok: true });
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{ "clip-path": "none" }}
          onSetStyle={onSetStyle}
          onSetAttribute={vi.fn()}
          onSetHtmlAttribute={vi.fn()}
        />,
      );
    });
    act(() =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Start cropping"]')
        ?.click(),
    );
    const top = host.querySelector<HTMLInputElement>('[data-crop-measurement="top"] input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(top, "24");
      top.dispatchEvent(new Event("input", { bubbles: true }));
      top.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    expect(onSetStyle).not.toHaveBeenCalled();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Apply crop"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSetStyle).toHaveBeenCalledTimes(1);
    expect(onSetStyle).toHaveBeenCalledWith("clip-path", "inset(24px 0px 0px 0px)");
    expect(useCropToolStore.getState().targetKey).toBeNull();
    act(() => root.unmount());
  });

  it("keeps crop mode open when Apply fails", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const element = makeVideoElement();
    const onSetStyle = vi.fn().mockResolvedValue({ ok: false, reason: "persist-failed" });
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{ "clip-path": "none" }}
          onSetStyle={onSetStyle}
          onSetAttribute={vi.fn()}
          onSetHtmlAttribute={vi.fn()}
        />,
      );
    });
    act(() =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Start cropping"]')
        ?.click(),
    );
    const top = host.querySelector<HTMLInputElement>('[data-crop-measurement="top"] input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(top, "8");
      top.dispatchEvent(new Event("input", { bubbles: true }));
      top.dispatchEvent(new Event("focusout", { bubbles: true }));
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Apply crop"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSetStyle).toHaveBeenCalledTimes(1);
    expect(useCropToolStore.getState().targetKey).not.toBeNull();
    expect(host.querySelector('[aria-label="Cancel crop"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("locks crop controls while Apply is pending and exits after success", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const element = makeVideoElement();
    element.element.style.clipPath = "inset(10px)";
    let settle: ((outcome: { ok: true }) => void) | undefined;
    const pending = new Promise<{ ok: true }>((resolve) => {
      settle = resolve;
    });
    const onSetStyle = vi.fn((property: string, value: string) => {
      element.element.style.setProperty(property, value);
      return pending;
    });

    function Harness() {
      const targetKey = useCropToolStore((state) => state.targetKey);
      const links = useCropToolStore((state) => state.links);
      const insets = useCropToolStore((state) => state.insets);
      const previewInsets = useCropToolStore((state) => state.previewInsets);
      return (
        <>
          <FlatMediaSection
            projectDir={null}
            element={element}
            styles={{ "clip-path": "inset(10px)" }}
            onSetStyle={onSetStyle}
            onSetAttribute={vi.fn()}
            onSetHtmlAttribute={vi.fn()}
          />
          {targetKey && (
            <DomEditCropHandles
              selection={element}
              overlayRect={{
                left: 0,
                top: 0,
                width: 1920,
                height: 1080,
                editScaleX: 1,
                editScaleY: 1,
              }}
              links={links}
              sessionInsets={insets}
              onSessionInsetsChange={previewInsets}
            />
          )}
        </>
      );
    }

    act(() => root.render(<Harness />));
    act(() =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Start cropping"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    const input = host.querySelector<HTMLInputElement>('[data-crop-measurement="top"] input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "16",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Apply crop"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

    expect(element.element.style.clipPath).toBe("inset(16px 10px 10px 10px)");
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="Cancel crop"]')?.disabled,
    ).toBe(true);
    settle?.({ ok: true });
    await act(async () => pending);
    expect(element.element.style.clipPath).toBe("inset(16px 10px 10px 10px)");
    expect(useCropToolStore.getState().targetKey).toBeNull();
    act(() => root.unmount());
  });
});

describe("FlatMediaSection — cutout", () => {
  it("shows the WebM label for video and fires background removal on click", async () => {
    const onRemoveBackground = vi.fn().mockResolvedValue({ outputPath: "assets/intro-loop.webm" });
    const onSetHtmlAttribute = vi.fn();
    const onSetAttribute = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const element = makeVideoElement();
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{}}
          onSetStyle={vi.fn()}
          onSetAttribute={onSetAttribute}
          onSetHtmlAttribute={onSetHtmlAttribute}
          onRemoveBackground={onRemoveBackground}
        />,
      );
    });
    expect(host.textContent).toContain("transparent WebM");
    const removeBgButton = host.querySelector<HTMLButtonElement>(
      '[data-flat-media-remove-bg="true"]',
    );
    expect(removeBgButton).not.toBeNull();
    await act(async () => {
      removeBgButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRemoveBackground).toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("toggles BG plate via FlatToggle", () => {
    const { host, root } = renderSection();
    const plateToggle = host.querySelector<HTMLButtonElement>(
      '[data-flat-toggle="true"][aria-label="BG plate"]',
    );
    expect(plateToggle).not.toBeNull();
    expect(plateToggle?.getAttribute("aria-checked")).toBe("false");
    act(() => plateToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(plateToggle?.getAttribute("aria-checked")).toBe("true");
    act(() => root.unmount());
  });
});

describe("FlatMediaSection — volume/rate/media-start", () => {
  it("renders unity volume as neutral 0 dB at the slider midpoint", () => {
    const onSetAttribute = vi.fn();
    const element = makeVideoElement({ dataAttributes: { volume: "1" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{}}
          onSetStyle={vi.fn()}
          onSetAttribute={onSetAttribute}
          onSetHtmlAttribute={vi.fn()}
        />,
      );
    });
    expect(host.textContent).toContain("0.0 dB");
    expect(
      host.querySelector('[data-flat-slider-track="true"]')?.getAttribute("aria-valuenow"),
    ).toBe("0");
    act(() => root.unmount());
  });

  it("commits +12 dB of boost from the upper half of the volume fader", () => {
    const onSetAttribute = vi.fn();
    const element = makeVideoElement({ dataAttributes: { volume: "1" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{}}
          onSetStyle={vi.fn()}
          onSetAttribute={onSetAttribute}
          onSetHtmlAttribute={vi.fn()}
        />,
      );
    });
    const volumeTrack = host.querySelectorAll('[data-flat-slider-track="true"]')[0];
    Object.defineProperty(volumeTrack, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 100, top: 0, height: 2, right: 100, bottom: 2 }),
    });
    act(() => {
      volumeTrack.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
      volumeTrack.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 100 }));
    });
    // Six decimals, not two: at two the bottom of the dB fader collapses onto
    // "0" (a hard mute) and every stop below unity writes a value the knob then
    // jumps away from.
    expect(onSetAttribute).toHaveBeenCalledWith("volume", "3.981072");
    act(() => root.unmount());
  });

  it("commits a new rate value on slider track pointerdown", () => {
    const onSetAttribute = vi.fn();
    const element = makeVideoElement();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{}}
          onSetStyle={vi.fn()}
          onSetAttribute={onSetAttribute}
          onSetHtmlAttribute={vi.fn()}
        />,
      );
    });
    const rateTrack = host.querySelectorAll('[data-flat-slider-track="true"]')[1];
    Object.defineProperty(rateTrack, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 100, top: 0, height: 2, right: 100, bottom: 2 }),
    });
    act(() => {
      rateTrack.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
      rateTrack.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 100 }));
    });
    // min=25, max=300, ratio=1.0 -> raw=300 -> commit(300) -> 300/100=3 -> "3"
    expect(onSetAttribute).toHaveBeenCalledWith("playback-rate", "3");
    act(() => root.unmount());
  });

  it("commits a new media-start value on slider track pointerdown", () => {
    const onSetAttribute = vi.fn();
    const element = makeVideoElement();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{}}
          onSetStyle={vi.fn()}
          onSetAttribute={onSetAttribute}
          onSetHtmlAttribute={vi.fn()}
        />,
      );
    });
    const mediaStartTrack = host.querySelectorAll('[data-flat-slider-track="true"]')[2];
    Object.defineProperty(mediaStartTrack, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 100, top: 0, height: 2, right: 100, bottom: 2 }),
    });
    act(() => {
      mediaStartTrack.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
      mediaStartTrack.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 100 }));
    });
    // no source-duration set -> mediaStartMax=Math.max(30, Math.ceil(0+10))=30 -> max=3000
    // ratio=1.0 -> raw=3000 -> commit(3000) -> (3000/100).toFixed(2) = "30.00"
    expect(onSetAttribute).toHaveBeenCalledWith("media-start", "30.00");
    act(() => root.unmount());
  });
});

describe("FlatMediaSection — loop/muted/has-audio", () => {
  it("toggles loop via onSetHtmlAttribute and shows has-audio-track for video", () => {
    const onSetHtmlAttribute = vi.fn();
    const onSetAttribute = vi.fn();
    const element = makeVideoElement({ dataAttributes: { "has-audio": "true" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{}}
          onSetStyle={vi.fn()}
          onSetAttribute={onSetAttribute}
          onSetHtmlAttribute={onSetHtmlAttribute}
        />,
      );
    });
    const loopToggle = host.querySelector<HTMLButtonElement>(
      '[data-flat-toggle="true"][aria-label="Loop"]',
    );
    act(() => loopToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSetHtmlAttribute).toHaveBeenCalledWith("loop", "true");

    const hasAudioToggle = host.querySelector<HTMLButtonElement>(
      '[data-flat-toggle="true"][aria-label="Has audio track"]',
    );
    expect(hasAudioToggle?.getAttribute("aria-checked")).toBe("true");
    act(() => root.unmount());
  });

  it("toggles muted via onSetHtmlAttribute", () => {
    const onSetHtmlAttribute = vi.fn();
    const onSetAttribute = vi.fn();
    const element = makeVideoElement();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{}}
          onSetStyle={vi.fn()}
          onSetAttribute={onSetAttribute}
          onSetHtmlAttribute={onSetHtmlAttribute}
        />,
      );
    });
    const mutedToggle = host.querySelector<HTMLButtonElement>(
      '[data-flat-toggle="true"][aria-label="Muted"]',
    );
    expect(mutedToggle?.getAttribute("aria-checked")).toBe("false");
    act(() => mutedToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSetHtmlAttribute).toHaveBeenCalledWith("muted", "true");
    act(() => root.unmount());
  });

  it("enables has-audio-track and clears muted on click", () => {
    const onSetHtmlAttribute = vi.fn();
    const onSetAttribute = vi.fn();
    const element = makeVideoElement();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{}}
          onSetStyle={vi.fn()}
          onSetAttribute={onSetAttribute}
          onSetHtmlAttribute={onSetHtmlAttribute}
        />,
      );
    });
    const hasAudioToggle = host.querySelector<HTMLButtonElement>(
      '[data-flat-toggle="true"][aria-label="Has audio track"]',
    );
    expect(hasAudioToggle?.getAttribute("aria-checked")).toBe("false");
    act(() => hasAudioToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSetAttribute).toHaveBeenCalledWith("has-audio", "true");
    expect(onSetHtmlAttribute).toHaveBeenCalledWith("muted", null);
    act(() => root.unmount());
  });

  it("disables has-audio-track and sets muted on click", () => {
    const onSetHtmlAttribute = vi.fn();
    const onSetAttribute = vi.fn();
    const element = makeVideoElement({ dataAttributes: { "has-audio": "true" } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{}}
          onSetStyle={vi.fn()}
          onSetAttribute={onSetAttribute}
          onSetHtmlAttribute={onSetHtmlAttribute}
        />,
      );
    });
    const hasAudioToggle = host.querySelector<HTMLButtonElement>(
      '[data-flat-toggle="true"][aria-label="Has audio track"]',
    );
    expect(hasAudioToggle?.getAttribute("aria-checked")).toBe("true");
    act(() => hasAudioToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSetAttribute).toHaveBeenCalledWith("has-audio", "");
    expect(onSetHtmlAttribute).toHaveBeenCalledWith("muted", "true");
    act(() => root.unmount());
  });
});

describe("FlatMediaSection — fit/position", () => {
  it("commits object-fit and object-position changes", () => {
    const onSetStyle = vi.fn();
    const { host, root } = (() => {
      const element = makeVideoElement();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      act(() => {
        root.render(
          <FlatMediaSection
            projectDir={null}
            element={element}
            styles={{ "object-fit": "cover", "object-position": "center" }}
            onSetStyle={onSetStyle}
            onSetAttribute={vi.fn()}
            onSetHtmlAttribute={vi.fn()}
          />,
        );
      });
      return { host, root };
    })();
    const selects = host.querySelectorAll("select");
    const fitSelect = Array.from(selects).find((s) => s.value === "cover");
    expect(fitSelect).not.toBeUndefined();
    act(() => {
      if (fitSelect) {
        fitSelect.value = "contain";
        fitSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(onSetStyle).toHaveBeenCalledWith("object-fit", "contain");
    act(() => root.unmount());
  });

  it("commits an object-position change", () => {
    const onSetStyle = vi.fn();
    const element = makeVideoElement();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{ "object-fit": "cover", "object-position": "center" }}
          onSetStyle={onSetStyle}
          onSetAttribute={vi.fn()}
          onSetHtmlAttribute={vi.fn()}
        />,
      );
    });
    const selects = host.querySelectorAll("select");
    const positionSelect = Array.from(selects).find((s) => s.value === "center");
    expect(positionSelect).not.toBeUndefined();
    act(() => {
      if (positionSelect) {
        positionSelect.value = "left top";
        positionSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(onSetStyle).toHaveBeenCalledWith("object-position", "left top");
    act(() => root.unmount());
  });
});

describe("FlatMediaSection — explicit resets", () => {
  it("resets volume, rate, and media start to their original defaults", () => {
    const onSetAttribute = vi.fn();
    const element = makeVideoElement({
      dataAttributes: { volume: "0.5", "playback-rate": "1.5", "media-start": "4.25" },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{}}
          onSetStyle={vi.fn()}
          onSetAttribute={onSetAttribute}
          onSetHtmlAttribute={vi.fn()}
        />,
      );
    });

    const resets = host.querySelectorAll<HTMLButtonElement>('[data-flat-slider-reset="true"]');
    expect(resets).toHaveLength(3);
    act(() => resets[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => resets[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => resets[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onSetAttribute).toHaveBeenNthCalledWith(1, "volume", "1");
    expect(onSetAttribute).toHaveBeenNthCalledWith(2, "playback-rate", "1");
    expect(onSetAttribute).toHaveBeenNthCalledWith(3, "media-start", "0.00");
    act(() => root.unmount());
  });

  it("resets fit and position to contain and center", () => {
    const onSetStyle = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={makeVideoElement()}
          styles={{ "object-fit": "cover", "object-position": "left top" }}
          onSetStyle={onSetStyle}
          onSetAttribute={vi.fn()}
          onSetHtmlAttribute={vi.fn()}
        />,
      );
    });

    const resets = host.querySelectorAll<HTMLButtonElement>('[data-flat-select-reset="true"]');
    expect(resets).toHaveLength(2);
    act(() => resets[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => resets[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSetStyle).toHaveBeenNthCalledWith(1, "object-fit", "contain");
    expect(onSetStyle).toHaveBeenNthCalledWith(2, "object-position", "center");
    act(() => root.unmount());
  });

  it("resets enabled media toggles while preserving has-audio disable semantics", () => {
    const onSetAttribute = vi.fn();
    const onSetHtmlAttribute = vi.fn();
    const element = makeVideoElement({ dataAttributes: { "has-audio": "true" } });
    element.element.setAttribute("loop", "");
    element.element.setAttribute("muted", "");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FlatMediaSection
          projectDir={null}
          element={element}
          styles={{}}
          onSetStyle={vi.fn()}
          onSetAttribute={onSetAttribute}
          onSetHtmlAttribute={onSetHtmlAttribute}
        />,
      );
    });

    const reset = (label: string) => {
      const button = host.querySelector<HTMLButtonElement>(
        `[data-flat-media-toggle-reset="true"][aria-label="Reset ${label}"]`,
      );
      expect(button).not.toBeNull();
      act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    };
    reset("Loop");
    reset("Muted");
    reset("Has audio track");

    expect(onSetHtmlAttribute).toHaveBeenNthCalledWith(1, "loop", null);
    expect(onSetHtmlAttribute).toHaveBeenNthCalledWith(2, "muted", null);
    expect(onSetAttribute).toHaveBeenCalledWith("has-audio", "");
    expect(onSetHtmlAttribute).toHaveBeenNthCalledWith(3, "muted", "true");
    act(() => root.unmount());
  });

  it("resets cutout quality and BG plate to their operation defaults", () => {
    const { host, root } = renderSection();
    const quality = Array.from(host.querySelectorAll("select")).find(
      (select) => select.getAttribute("aria-label") === "Quality",
    );
    expect(quality).not.toBeUndefined();
    act(() => {
      if (quality) {
        quality.value = "best";
        quality.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    const qualityReset = host.querySelector<HTMLButtonElement>('[data-flat-select-reset="true"]');
    expect(qualityReset).not.toBeNull();
    act(() => qualityReset?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(quality?.value).toBe("balanced");

    const plateToggle = host.querySelector<HTMLButtonElement>(
      '[data-flat-toggle="true"][aria-label="BG plate"]',
    );
    act(() => plateToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const plateReset = host.querySelector<HTMLButtonElement>(
      '[data-flat-media-toggle-reset="true"][aria-label="Reset BG plate"]',
    );
    expect(plateReset).not.toBeNull();
    act(() => plateReset?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(plateToggle?.getAttribute("aria-checked")).toBe("false");
    act(() => root.unmount());
  });

  it("does not offer reset actions for controls already at their defaults", () => {
    const { host, root } = renderSection();
    expect(host.querySelector('[data-flat-slider-reset="true"]')).toBeNull();
    expect(host.querySelector('[data-flat-select-reset="true"]')).toBeNull();
    expect(host.querySelector('[data-flat-media-toggle-reset="true"]')).toBeNull();
    act(() => root.unmount());
  });
});
