// @vitest-environment happy-dom

import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NLEPreview, getPreviewPlayerKey, resolvePreviewStageSize } from "./NLEPreview";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../player", async () => {
  const React = await import("react");

  return {
    Player: React.forwardRef(function MockPlayer(
      props: {
        onLoad?: () => void;
        style?: React.CSSProperties;
      },
      ref: React.ForwardedRef<HTMLIFrameElement>,
    ) {
      React.useEffect(() => {
        props.onLoad?.();
      }, [props]);

      return React.createElement("div", {
        ref: ref as React.ForwardedRef<HTMLDivElement>,
        "data-testid": "mock-player",
        style: props.style,
      });
    }),
  };
});

const uiPreferences = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("../../utils/studioUiPreferences", () => ({
  readStudioUiPreferences: () => uiPreferences.value,
  writeStudioUiPreferences: () => {},
}));

let resizeCallbacks: Array<() => void> = [];

class MockResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe() {
    const fire = () => this.cb([], this as unknown as ResizeObserver);
    resizeCallbacks.push(fire);
    fire();
  }
  disconnect() {}
}

const originalResizeObserver = globalThis.ResizeObserver;

function setRect(node: Element, rect: { width: number; height: number }) {
  Object.defineProperty(node, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: rect.width,
      bottom: rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({}),
    }),
  });
}

function renderPreview() {
  resizeCallbacks = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const iframeRef = createRef<HTMLIFrameElement>();

  act(() => {
    root.render(
      React.createElement(NLEPreview, {
        projectId: "timeline-edit-playground",
        iframeRef,
        onIframeLoad: () => {},
      }),
    );
  });

  const viewport = host.querySelector('[aria-label="Composition preview"]') as HTMLDivElement;
  const stage = host.querySelector('[data-testid="preview-zoom-stage"]') as HTMLDivElement;
  expect(viewport).toBeTruthy();
  expect(stage).toBeTruthy();

  setRect(viewport, { width: 800, height: 600 });
  act(() => {
    for (const fire of resizeCallbacks) fire();
  });

  return {
    host,
    root,
    viewport,
    stage,
    cleanup() {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe("getPreviewPlayerKey", () => {
  it("uses projectId as key when no directUrl", () => {
    expect(getPreviewPlayerKey({ projectId: "timeline-edit-playground" })).toBe(
      "timeline-edit-playground",
    );
  });

  it("switches identity when drilling into a different directUrl", () => {
    expect(
      getPreviewPlayerKey({
        projectId: "timeline-edit-playground",
        directUrl: "/api/projects/timeline-edit-playground/preview",
      }),
    ).not.toBe(
      getPreviewPlayerKey({
        projectId: "timeline-edit-playground",
        directUrl: "/api/projects/timeline-edit-playground/preview/comp/compositions/intro.html",
      }),
    );
  });
});

describe("resolvePreviewStageSize", () => {
  it("fits portrait composition dimensions by height in a narrow viewport", () => {
    expect(resolvePreviewStageSize(512, 402, { width: 1080, height: 1920 }, undefined)).toEqual({
      width: 217.125,
      height: 386,
    });
  });

  it("uses composition dimensions ahead of the legacy portrait fallback", () => {
    expect(resolvePreviewStageSize(512, 402, { width: 1920, height: 1080 }, true)).toEqual({
      width: 496,
      height: 279,
    });
  });

  it("keeps canvas sizing on the authored ratio rather than an export preset", () => {
    const squareCanvas = resolvePreviewStageSize(
      1000,
      700,
      { width: 1080, height: 1080 },
      false,
    );
    expect(squareCanvas.width / squareCanvas.height).toBe(1);
  });
});

describe("NLEPreview", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as typeof ResizeObserver;
    uiPreferences.value = {};
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it("keeps a fit canvas centered during middle-mouse drag", () => {
    const view = renderPreview();
    const target = document.createElement("div");
    view.stage.appendChild(target);

    act(() => {
      target.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 1,
          button: 1,
          clientX: 240,
          clientY: 180,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 1,
          clientX: 300,
          clientY: 220,
        }),
      );
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 1,
        }),
      );
    });

    expect(view.stage.style.transform).toContain("translate3d(0px, 0px, 0)");
    view.cleanup();
  });

  it("keeps a fit canvas centered during a two-finger wheel gesture", () => {
    const view = renderPreview();
    const target = document.createElement("div");
    view.stage.appendChild(target);

    act(() => {
      target.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: 240,
          clientY: 180,
          deltaX: -30,
          deltaY: 24,
        }),
      );
    });

    expect(view.stage.style.transform).toContain("translate3d(0px, 0px, 0)");
    view.cleanup();
  });

  it("renders the fixed-ratio canvas as a different surface from the player area", () => {
    const view = renderPreview();

    expect(view.viewport.getAttribute("data-preview-player-surface")).toBe("true");
    expect(view.stage.getAttribute("data-preview-canvas")).toBe("true");
    expect(view.stage.style.width).toBe("784px");
    expect(view.stage.style.height).toBe("441px");
    expect(view.stage.style.aspectRatio).toBe("16 / 9");
    expect(view.viewport.style.backgroundColor).not.toBe(view.stage.style.backgroundColor);
    view.cleanup();
  });

  it("normalizes an old below-Fit persisted zoom instead of restoring a detached canvas", () => {
    uiPreferences.value = {
      previewZoom: { zoomPercent: 47, panX: 312, panY: -240 },
    };

    const view = renderPreview();

    expect(view.stage.style.transform).toBe("translate3d(0px, 0px, 0) scale(1)");
    expect(view.viewport.className).toContain("overflow-hidden");
    view.cleanup();
  });
});
