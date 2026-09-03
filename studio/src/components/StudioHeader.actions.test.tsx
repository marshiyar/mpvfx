// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const studioContext = vi.hoisted(() => ({ projectId: "demo" }));

vi.mock("../contexts/StudioContext", () => ({
  useStudioShellContext: () => ({
    projectId: studioContext.projectId,
    editHistory: { canUndo: false, canRedo: false },
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    renderQueue: { isRendering: false, ffmpegMissing: false },
  }),
}));

vi.mock("../contexts/PanelLayoutContext", () => ({
  usePanelLayoutContext: () => ({
    effectiveRightCollapsed: false,
    setRightCollapsed: vi.fn(),
    setRightPanelTab: vi.fn(),
  }),
}));

import { StudioHeader } from "./StudioHeader";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  studioContext.projectId = "demo";
});

afterEach(() => {
  document.body.innerHTML = "";
});

it("keeps export in the Renders panel instead of duplicating it in the header", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => {
    root.render(
      <StudioHeader
        captureFrameHref="#capture"
        captureFrameFilename="frame.png"
        handleCaptureFrameClick={vi.fn()}
        refreshCaptureFrameTime={vi.fn()}
      />,
    );
  });

  expect(
    Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Export"),
  ).toBeUndefined();
  expect(host.querySelector('[aria-label="Inspector"]')).toBeNull();
  expect(host.querySelector('button[aria-label="Undo"]')).toBeNull();
  expect(host.querySelector('button[aria-label="Redo"]')).toBeNull();
  act(() => root.unmount());
});

it.each(["MpVFX", " mpvfx "])(
  "shows MpVFX only once when the project name is %j",
  (projectId) => {
    studioContext.projectId = projectId;
    const host = document.createElement("div");
    const root = createRoot(host);

    act(() => {
      root.render(
        <StudioHeader
          captureFrameHref="#capture"
          captureFrameFilename="frame.png"
          handleCaptureFrameClick={vi.fn()}
          refreshCaptureFrameTime={vi.fn()}
        />,
      );
    });

    expect(host.textContent?.match(/MpVFX/g)).toHaveLength(1);
    expect(host.textContent).not.toContain("|");
    act(() => root.unmount());
  },
);

it("still shows a distinct project name beside MpVFX", () => {
  studioContext.projectId = "my-project";
  const host = document.createElement("div");
  const root = createRoot(host);

  act(() => {
    root.render(
      <StudioHeader
        captureFrameHref="#capture"
        captureFrameFilename="frame.png"
        handleCaptureFrameClick={vi.fn()}
        refreshCaptureFrameTime={vi.fn()}
      />,
    );
  });

  expect(host.textContent).toContain("MpVFX");
  expect(host.textContent).toContain("my-project");
  expect(host.textContent).toContain("|");
  act(() => root.unmount());
});
