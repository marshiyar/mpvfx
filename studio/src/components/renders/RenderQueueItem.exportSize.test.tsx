// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { RenderQueueItem } from "./RenderQueueItem";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("completed export size", () => {
  it("shows the actual file size returned by render history", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <RenderQueueItem
          job={{
            id: "render-1",
            status: "complete",
            progress: 100,
            filename: "render-1.mp4",
            createdAt: Date.now(),
            sizeBytes: 2.5 * 1024 * 1024,
          }}
          projectId="demo"
          onDelete={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });

    expect(host.textContent).toContain("2.5 MB");
    act(() => root.unmount());
    host.remove();
  });
});
