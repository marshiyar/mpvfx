// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DomEditSelection } from "./domEditing";
import { DomEditOverlay } from "./DomEditOverlay";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const hoverState = vi.hoisted(() => ({ angle: 0, selected: false }));

vi.mock("./useDomEditOverlayRects", () => ({
  useDomEditOverlayRects: ({
    hoverSelectionRef,
  }: {
    hoverSelectionRef: { current: unknown };
  }) => ({
    overlayRect: null,
    overlayRectRef: { current: null },
    setOverlayRect: () => undefined,
    hoverRect: hoverSelectionRef.current
      ? {
          left: 20,
          top: 30,
          width: 100,
          height: 40,
          editScaleX: 1,
          editScaleY: 1,
          angle: hoverState.angle,
        }
      : null,
    groupOverlayItems: [],
    groupOverlayItemsRef: { current: [] },
    setGroupOverlayItems: () => undefined,
    childRects: [],
  }),
}));

vi.mock("./useDomEditCompositionRect", () => ({
  useDomEditCompositionRect: () => ({
    left: 0,
    top: 0,
    width: 800,
    height: 450,
    scaleX: 1,
    scaleY: 1,
  }),
}));

function renderHover(angle: number, clipPath = "none") {
  hoverState.angle = angle;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const element = document.createElement("div");
  element.style.clipPath = clipPath;
  const hoverSelection = { element } as unknown as DomEditSelection;
  act(() => {
    root.render(
      <DomEditOverlay
        iframeRef={{ current: document.createElement("iframe") }}
        activeCompositionPath={null}
        selection={null}
        hoverSelection={hoverSelection}
        onCanvasMouseDown={() => undefined}
        onCanvasPointerMove={() => Promise.resolve(null)}
        onCanvasPointerLeave={() => undefined}
        onSelectionChange={() => undefined}
        onBlockedMove={() => undefined}
        onPathOffsetCommit={() => undefined}
        onGroupPathOffsetCommit={() => undefined}
        onBoxSizeCommit={() => undefined}
        onRotationCommit={() => undefined}
      />,
    );
  });
  const box = host.querySelector<HTMLElement>(
    '[data-dom-edit-hover-box="true"]',
  );
  const style = box?.style;
  act(() => root.unmount());
  host.remove();
  return {
    transform: style?.transform ?? "",
    left: style?.left ?? "",
    top: style?.top ?? "",
    width: style?.width ?? "",
    height: style?.height ?? "",
  };
}

it("rotates the hover box with the element", () => {
  expect(renderHover(30).transform).toBe("rotate(30deg)");
});

it("leaves the hover box untransformed at angle zero", () => {
  expect(renderHover(0).transform).toBe("");
});

it("renders the already-normalized live hover bounds without cropping them a second time", () => {
  expect(renderHover(0, "inset(5px 10px 15px 20px)")).toEqual({
    transform: "",
    left: "20px",
    top: "30px",
    width: "100px",
    height: "40px",
  });
});
