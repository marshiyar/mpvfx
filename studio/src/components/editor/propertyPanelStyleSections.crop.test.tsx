// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DomEditSelection } from "./domEditing";
import { StyleSections } from "./propertyPanelStyleSections";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps overflow but does not expose legacy mask controls for video", () => {
  const video = document.createElement("video");
  const selection = {
    element: video,
    id: "clip",
    selector: "#clip",
    label: "Clip",
    tagName: "video",
    sourceFile: "index.html",
    compositionPath: "index.html",
    boundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
    textContent: "",
    dataAttributes: {},
    inlineStyles: {},
    computedStyles: {},
    textFields: [],
    capabilities: {
      canEditStyles: true,
      canCrop: true,
    },
  } as unknown as DomEditSelection;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      <StyleSections
        projectId="project"
        element={selection}
        styles={{ overflow: "hidden", "clip-path": "inset(8px)" }}
        assets={[]}
        onSetStyle={vi.fn()}
      />,
    );
  });
  act(() =>
    host
      .querySelector<HTMLButtonElement>('[data-panel-section="clip"] button')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );

  expect(host.textContent).toContain("Overflow");
  expect(host.textContent).not.toContain("Mask");
  expect(host.textContent).not.toContain("Mask inset");
  act(() => root.unmount());
  host.remove();
});
