// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../player", () => ({
  PlayerControls: () => <div data-player-controls="" />,
}));
vi.mock("./NLEPreview", () => ({
  NLEPreview: () => <div data-nle-preview="" />,
}));
vi.mock("./CompositionBreadcrumb", () => ({ CompositionBreadcrumb: () => null }));
vi.mock("./AssetPreviewOverlay", () => ({ AssetPreviewOverlay: () => null }));
vi.mock("./usePreviewBlockDrop", () => ({
  usePreviewBlockDrop: () => ({
    handleDragOver: vi.fn(),
    handleDrop: vi.fn(),
  }),
}));
vi.mock("./NLEContext", () => ({
  useNLEContext: () => ({
    projectId: "demo",
    iframeRef: { current: null },
    togglePlay: vi.fn(),
    seek: vi.fn(),
    onIframeLoad: vi.fn(),
    compositionStack: [{ id: "master", label: "Master", previewUrl: "/preview" }],
    handleNavigateComposition: vi.fn(),
    setCompositionLoading: vi.fn(),
    timelineDisabled: false,
    hasLoadedOnceRef: { current: true },
    previewCompositionSize: { width: 1920, height: 1080 },
    setPreviewCompositionSize: vi.fn(),
  }),
}));

import { PreviewPane } from "./PreviewPane";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

it("does not cover the preview with a large dashed green drop outline", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<PreviewPane />));

  const hasDashedOutline = Array.from(host.querySelectorAll<HTMLElement>("[class]")).some(
    (element) => element.className.includes("border-dashed"),
  );
  expect(hasDashedOutline).toBe(false);
  expect(host.querySelector("[data-nle-preview]")).not.toBeNull();
  act(() => root.unmount());
});
