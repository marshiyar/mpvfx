// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineEmptyState } from "./TimelineEmptyState";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function renderEmptyState(onFileDrop: boolean): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <TimelineEmptyState
        isDragOver={false}
        onFileDrop={onFileDrop}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />,
    );
  });
  return host;
}

describe("TimelineEmptyState", () => {
  it("starts a media-first editing workflow when file drop is available", () => {
    const host = renderEmptyState(true);

    expect(host.textContent).toContain("Drop video, audio, or images here to start editing");
    expect(host.textContent?.toLowerCase()).not.toContain("describe");
    expect(host.textContent?.toLowerCase()).not.toContain("composition");
  });

  it("uses editor language even when direct file drop is unavailable", () => {
    const host = renderEmptyState(false);

    expect(host.textContent).toContain("Import media to start editing");
    expect(host.textContent?.toLowerCase()).not.toContain("describe");
  });
});
