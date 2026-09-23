// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderQueue, type CompositionDimensions } from "./RenderQueue";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;

beforeEach(() => localStorage.clear());
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function mount(dimensions: CompositionDimensions = { width: 1920, height: 1080 }) {
  const onStartRender = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <RenderQueue
        jobs={[]}
        projectId="demo"
        onDelete={vi.fn()}
        onClearCompleted={vi.fn()}
        onStartRender={onStartRender}
        isRendering={false}
        compositionDimensions={dimensions}
        ffmpeg={{ ok: true }}
        ffmpegChecking={false}
        onRecheckFfmpeg={vi.fn()}
      />,
    );
  });
  const selects = [...host.querySelectorAll("select")];
  const format = selects.find((select) => [...select.options].some((o) => o.value === "webm"));
  const resolution = selects.find((select) =>
    [...select.options].some((o) => o.value === "uhd-4k"),
  );
  if (!format || !resolution) throw new Error("export selectors did not render");
  const exportButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Export");
  if (!exportButton) throw new Error("Export button did not render");
  return { host, onStartRender, format, resolution, exportButton };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("native input setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("export format option compatibility", () => {
  it("offers expanded exact-dimension and 8K export presets", () => {
    const { resolution } = mount();
    const values = [...resolution.options].map((option) => option.value);
    expect(values).toEqual(
      expect.arrayContaining([
        "hd-720",
        "full-hd",
        "qhd",
        "uhd-4k",
        "uhd-8k",
        "vertical-full-hd",
        "vertical-8k",
        "square-full-hd",
        "social-4-5",
        "classic-4-3",
        "cinema-21-9",
        "custom",
      ]),
    );
    expect([...resolution.options].find((option) => option.value === "uhd-8k")?.textContent).toContain(
      "7680×4320",
    );
    expect([...resolution.options].find((option) => option.value === "1080p")).toBeUndefined();
    expect([...resolution.options].find((option) => option.value === "4k")).toBeUndefined();
  });

  it("reveals custom dimensions, reports the ratio, and submits the exact target", () => {
    const ui = mount();
    act(() => {
      ui.resolution.value = "custom";
      ui.resolution.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const width = ui.host.querySelector<HTMLInputElement>('input[aria-label="Custom export width"]');
    const height = ui.host.querySelector<HTMLInputElement>('input[aria-label="Custom export height"]');
    if (!width || !height) throw new Error("custom dimension inputs did not render");
    act(() => {
      setInputValue(width, "1080");
      setInputValue(height, "1350");
    });
    expect(ui.host.textContent).toContain("4:5");
    expect(ui.exportButton.disabled).toBe(false);
    act(() => ui.exportButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(ui.onStartRender).toHaveBeenCalledWith(
      "mp4",
      "standard",
      { width: 1080, height: 1350 },
      30,
    );
  });

  it("blocks a custom target beyond the 8K cap", () => {
    const ui = mount();
    act(() => {
      ui.resolution.value = "custom";
      ui.resolution.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const width = ui.host.querySelector<HTMLInputElement>('input[aria-label="Custom export width"]');
    const height = ui.host.querySelector<HTMLInputElement>('input[aria-label="Custom export height"]');
    if (!width || !height) throw new Error("custom dimension inputs did not render");
    act(() => {
      setInputValue(width, "7682");
      setInputValue(height, "4320");
    });
    expect(ui.exportButton.disabled).toBe(true);
    expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain("8K");
  });

  it.each(["webm", "mov"] as const)(
    "keeps exact output dimensions available for %s",
    (nextFormat) => {
      const ui = mount();
      act(() => {
        ui.resolution.value = "uhd-4k";
        ui.resolution.dispatchEvent(new Event("change", { bubbles: true }));
        ui.format.value = nextFormat;
        ui.format.dispatchEvent(new Event("change", { bubbles: true }));
      });

      expect(ui.resolution.value).toBe("uhd-4k");

      act(() => ui.exportButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(ui.onStartRender).toHaveBeenCalledWith(
        nextFormat,
        "standard",
        { width: 3840, height: 2160 },
        30,
      );
    },
  );

  it("shows exact square output dimensions", () => {
    const { resolution } = mount({ width: 1080, height: 1080 });
    expect([...resolution.options].find((o) => o.value === "square-full-hd")?.textContent).toContain(
      "1080×1080",
    );
    expect([...resolution.options].find((o) => o.value === "square-4k")?.textContent).toContain(
      "2160×2160",
    );
  });

  it.each([
    [{ width: 1920, height: 1080 }, "uhd-4k"],
    [{ width: 1080, height: 1920 }, "vertical-4k"],
    [{ width: 1080, height: 1080 }, "square-4k"],
  ] as const)("migrates a persisted legacy 4K scale for the canvas aspect", (dimensions, expected) => {
    localStorage.setItem(
      "hf-studio-render-settings",
      JSON.stringify({ format: "mp4", quality: "high", fps: 60, resolution: "4k" }),
    );
    expect(mount(dimensions).resolution.value).toBe(expected);
    expect(JSON.parse(localStorage.getItem("hf-studio-render-settings") ?? "{}").resolution).toBe(
      "4k",
    );
  });

  it("blocks Auto when the authored canvas exceeds the 8K envelope", () => {
    const ui = mount({ width: 8000, height: 4500 });
    expect(ui.exportButton.disabled).toBe(true);
    expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain("8K");
  });
});
