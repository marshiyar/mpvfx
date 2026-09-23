// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { formatRenderProgress, formatRenderStage, RenderQueueItem } from "./RenderQueueItem";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("active export progress presentation", () => {
  it("shows one decimal place and hides internal render-worker details", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <RenderQueueItem
          job={{
            id: "render-1",
            status: "rendering",
            progress: 23.400000000000002,
            stage: "Capturing frame 180/9733 (5 workers)",
            filename: "render-1.mp4",
            createdAt: Date.now(),
          }}
          projectId="demo"
          onDelete={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });

    expect(host.textContent).toContain("Capturing frame 180/9733");
    expect(host.textContent).not.toContain("workers");
    expect(host.textContent).toContain("23.4%");
    expect(host.textContent).not.toContain("23.400000000000002%");
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe(
      "Render progress: 23.4%",
    );

    act(() => root.unmount());
    host.remove();
  });

  it.each([
    [23.46, "23.5"],
    [23, "23"],
    [-1, "0"],
    [101, "100"],
    [Number.NaN, "0"],
    [Number.POSITIVE_INFINITY, "0"],
    [Number.NEGATIVE_INFINITY, "0"],
  ])("formats and clamps progress %s as %s", (input, expected) => {
    expect(formatRenderProgress(input)).toBe(expected);
  });

  it.each([
    ["Capturing frame 1/10 (1 worker)", "Capturing frame 1/10"],
    ["Capturing frame 1/10 (2 WORKERS)   ", "Capturing frame 1/10"],
    ["Encoding (software mode)", "Encoding (software mode)"],
    ["Using (5 workers) for analysis", "Using (5 workers) for analysis"],
    ["(5 workers)", "Rendering"],
    ["   ", "Rendering"],
    [undefined, "Rendering"],
  ])("presents stage %s as %s", (input, expected) => {
    expect(formatRenderStage(input)).toBe(expected);
  });
});
