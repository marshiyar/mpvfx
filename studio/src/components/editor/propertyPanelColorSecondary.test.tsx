// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeHfColorGrading } from "@hyperframes/core/color-grading";
import * as frameAnalysis from "./colorGradingFrameAnalysis";
import { PropertyPanelColorSecondary } from "./propertyPanelColorSecondary";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function normalizedSecondaries(count: number) {
  const grading = normalizeHfColorGrading({
    secondaries: Array.from({ length: count }, () => ({ key: {}, correction: {} })),
  });
  if (!grading) throw new Error("Expected normalized grading");
  return grading.secondaries ?? [];
}

function renderSecondary({
  secondaries = normalizedSecondaries(1),
  captureFrame = vi.fn().mockResolvedValue(null),
  onCommit = vi.fn(),
} = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() =>
    root.render(
      <PropertyPanelColorSecondary
        secondaries={secondaries}
        captureFrame={captureFrame}
        onCommit={onCommit}
      />,
    ),
  );
  return { host, root, onCommit };
}

async function captureSecondaryFrame(host: HTMLElement) {
  const capture = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Sample color from frame"),
  );
  await act(async () => {
    capture?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("PropertyPanelColorSecondary", () => {
  it("adds a normalized secondary and enforces the contract limit", () => {
    const { host, root, onCommit } = renderSecondary({ secondaries: [] });
    act(() => {
      host
        .querySelector<HTMLButtonElement>('button[title="Add color selection"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCommit.mock.calls[0]?.[0]).toHaveLength(1);
    expect(onCommit.mock.calls[0]?.[0]?.[0]).toMatchObject({ enabled: true });
    act(() => root.unmount());

    const maximum = renderSecondary({ secondaries: normalizedSecondaries(4) });
    expect(
      maximum.host.querySelector<HTMLButtonElement>('button[title="Add secondary color selection"]')
        ?.disabled,
    ).toBe(true);
    act(() => maximum.root.unmount());
  });

  it("bypasses a secondary without deleting its qualifier or correction", () => {
    const secondaries = normalizedSecondaries(1).map((secondary) => ({
      ...secondary,
      correction: { ...secondary.correction, luma: 0.2 },
    }));
    const { host, root, onCommit } = renderSecondary({ secondaries });

    act(() => {
      host
        .querySelector<HTMLButtonElement>('[role="switch"][aria-label="Selection enabled"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCommit.mock.calls[0]?.[0]?.[0]).toMatchObject({
      enabled: false,
      correction: { luma: 0.2 },
      key: secondaries[0]?.key,
    });
    act(() => root.unmount());
  });

  it("keeps saturation and luma ranges strictly ordered", () => {
    const { host, root, onCommit } = renderSecondary();

    act(() => {
      host
        .querySelector<HTMLElement>('[role="slider"][aria-label="Saturation min"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(onCommit.mock.calls.at(-1)?.[0]?.[0]?.key.saturation).toMatchObject({
      min: 0.99,
      max: 1,
    });

    act(() => {
      host
        .querySelector<HTMLElement>('[role="slider"][aria-label="Luma max"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(onCommit.mock.calls.at(-1)?.[0]?.[0]?.key.luma).toMatchObject({
      min: 0,
      max: 0.01,
    });
    act(() => root.unmount());
  });

  it("preserves legal fractional hue centers at the wrap boundary", () => {
    const grading = normalizeHfColorGrading({
      secondaries: [
        {
          key: { hue: { center: 359.7, range: 20 } },
          correction: {},
        },
      ],
    });
    if (!grading?.secondaries) throw new Error("Expected normalized secondaries");
    const { host, root } = renderSecondary({ secondaries: grading.secondaries });
    const hue = host.querySelector<HTMLElement>('[role="slider"][aria-label="Hue"]');

    expect(Number(hue?.getAttribute("aria-valuenow"))).toBeCloseTo(359.7);
    expect(hue?.getAttribute("aria-valuemax")).toBe("359.99");
    act(() => root.unmount());
  });

  it.each([
    "Hue",
    "Hue range",
    "Hue softness",
    "Saturation min",
    "Saturation max",
    "Saturation softness",
    "Luma min",
    "Luma max",
    "Luma softness",
  ])("resets the %s qualifier to its normalized default without changing correction", (label) => {
    const defaults = normalizedSecondaries(1)[0]!;
    const grading = normalizeHfColorGrading({
      secondaries: [
        {
          key: {
            hue: { center: 42, range: 30, softness: 12 },
            saturation: { min: 0.2, max: 0.8, softness: 0.2 },
            luma: { min: 0.1, max: 0.9, softness: 0.15 },
          },
          correction: { luma: 0.2 },
        },
      ],
    });
    if (!grading?.secondaries) throw new Error("Expected normalized secondaries");
    const { host, root, onCommit } = renderSecondary({ secondaries: grading.secondaries });

    act(() => {
      host
        .querySelector<HTMLButtonElement>(`[aria-label="Reset ${label}"]`)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    const next = onCommit.mock.calls[0]?.[0]?.[0];
    expect(next?.correction).toEqual(grading.secondaries[0]?.correction);
    const defaultKey = defaults.key as unknown as Record<string, Record<string, number>>;
    const nextKey = next?.key as unknown as Record<string, Record<string, number>>;
    const parts = label.toLowerCase().split(" ");
    const family = parts[0] === "hue" ? "hue" : parts[0];
    const member = parts.length === 1 ? "center" : parts.at(-1)!;
    expect(nextKey[family]?.[member]).toBe(defaultKey[family]?.[member]);
    act(() => root.unmount());
  });

  it("resets Selection enabled to its default without deleting qualifier data", () => {
    const grading = normalizeHfColorGrading({
      secondaries: [{ enabled: false, key: { hue: { center: 42 } }, correction: { luma: 0.2 } }],
    });
    if (!grading?.secondaries) throw new Error("Expected normalized secondaries");
    const { host, root, onCommit } = renderSecondary({ secondaries: grading.secondaries });

    act(() => {
      host
        .querySelector<HTMLButtonElement>('[aria-label="Reset Selection enabled"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCommit.mock.calls[0]?.[0]?.[0]).toMatchObject({
      enabled: true,
      key: grading.secondaries[0]?.key,
      correction: grading.secondaries[0]?.correction,
    });
    act(() => root.unmount());
  });

  it("shows a useful error when frame capture is unavailable", async () => {
    const { host, root, onCommit } = renderSecondary({
      captureFrame: vi.fn().mockRejectedValue(new Error("capture unavailable")),
    });
    await captureSecondaryFrame(host);

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Preview frame unavailable",
    );
    expect(onCommit).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("decodes a captured frame once and samples its center from the keyboard", async () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 255;
      pixels[offset + 3] = 255;
    }
    const decode = vi.spyOn(frameAnalysis, "readColorGradingFramePixels").mockResolvedValue(pixels);
    const { host, root, onCommit } = renderSecondary({
      captureFrame: vi.fn().mockResolvedValue({
        dataUrl: "data:image/png;base64,",
        width: 4,
        height: 4,
      }),
    });
    await captureSecondaryFrame(host);

    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('[aria-label="Sample color from captured frame"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    });

    expect(decode).toHaveBeenCalledOnce();
    expect(onCommit.mock.calls[0]?.[0]?.[0]?.key.hue.center).toBeCloseTo(0);
    const matteToggle = Array.from(
      host.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]'),
    ).find((button) => button.textContent?.includes("Selection matte"));
    expect(matteToggle).toBeDefined();
    act(() => root.unmount());
  });
});
