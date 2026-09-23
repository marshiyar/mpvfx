// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { RenderQueue } from "./RenderQueue";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("export format guidance", () => {
  it("describes MP4 compatibility without absolute size or universal-playback claims", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <RenderQueue
          jobs={[]}
          projectId="demo"
          onDelete={vi.fn()}
          onClearCompleted={vi.fn()}
          onStartRender={vi.fn()}
          isRendering={false}
          compositionDimensions={{ width: 1920, height: 1080 }}
          ffmpeg={{ ok: true }}
          ffmpegChecking={false}
          onRecheckFfmpeg={vi.fn()}
        />,
      );
    });

    const info = host.querySelector<HTMLButtonElement>('button[aria-label="About video formats"]');
    if (!info) throw new Error("format help did not render");
    act(() => info.click());

    expect(document.body.textContent).toContain("Broad playback compatibility");
    expect(document.body.textContent).not.toMatch(/smallest file|universal playback/i);

    act(() => root.unmount());
    host.remove();
  });
});
